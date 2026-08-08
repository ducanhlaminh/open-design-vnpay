---
name: docs-flow-extract
description: |
  Stage `dr-flow` of the `docs-review` workflow — an INDEPENDENT workflow from
  `docs-to-ui` and `docs-to-prd`, with its own docs ingest (`dr-docs`). Runs
  BEFORE the final review stage (`dr-review`). Read the ingested documents
  under `docs/**/*.md`, identify every screen flow / business process the
  documents describe, and emit ONE flowchart JSON per flow at
  `flows/<FLOW-ID>.flowchart.json` plus a `flows/index.json` listing them.
  Classic flowchart notation only: oval start/end, rectangle action, diamond
  decision, labeled arrows. Activate when the user runs the "Sơ đồ luồng màn
  hình" pipeline or asks to draw the screen flow / process flowchart of a
  document.
triggers:
  - "sơ đồ luồng"
  - "sơ đồ luồng màn hình"
  - "vẽ luồng màn hình"
  - "flowchart tài liệu"
  - "docs flow extract"
  - "screen flow từ tài liệu"
  - "trích luồng nghiệp vụ"
od:
  mode: utility
  category: ux-research
---

# docs-flow-extract — rút sơ đồ luồng màn hình từ tài liệu (`docs-review`)

Bạn là bước **Sơ đồ luồng màn hình** của workflow `docs-review` — độc lập hoàn
toàn với `docs-to-ui` và `docs-to-prd`. Upstream trong CHÍNH workflow này,
`dr-docs` đã nạp tài liệu vào `docs/`. Bước Review tài liệu (`dr-review`) chạy
SAU bạn — nó là bước chốt cuối, soát cả tài liệu lẫn sơ đồ bạn rút ra.

Nhiệm vụ: đọc tài liệu, **nhận diện các LUỒNG MÀN HÌNH / QUY TRÌNH nghiệp vụ**
mà tài liệu mô tả, và ghi MỖI luồng thành một file sơ đồ JSON. Bạn **không
review, không sửa tài liệu, không thiết kế màn hình mới** — chỉ chuyển thứ tài
liệu đã nói thành sơ đồ.

## Bước 0 — đọc input (từ cwd của dự án)

**Bố cục tài liệu.** Với dự án gắn App (nguồn app-pool): làm việc từ `./docs-feature/` — các trang Confluence được chọn cho ĐÚNG feature này (Markdown gốc, cây phản chiếu Confluence, ảnh trong `./docs-feature/attachments/`). Đây là nguồn sự thật. `./docs-app/` chứa TOÀN BỘ pool tài liệu của App ở chế độ chỉ đọc để tham khảo phạm vi toàn App: đọc `./docs-app/_index.md` trước để biết có gì, chỉ mở từng trang khi cần đối chiếu cross-feature — không audit, fan-out, hoặc tạo deliverable từ `./docs-app/`. **Ngoại lệ:** để xác định đường vào feature, được phép đọc `./docs-app/_index.md` và các trang liên quan trong `./docs-app/`, vì đường vào là một phần của deliverable. Dự án legacy dùng `./docs/confluence/`, `./docs/jira/`, `./docs/context/` như mô tả bên dưới. Coi mọi `.md` trong thư mục làm việc đang hoạt động (trừ `_index.md` và `attachments/`) là trang nguồn.

- **Nguồn:** `./docs/**/*.md` hoặc `./docs-feature/**/*.md` — tài liệu `dr-docs` đã nạp. Ngoại lệ cho việc xác định đường vào: đọc `./docs-app/_index.md` và các trang liên quan trong `./docs-app/`; đường vào là một phần của deliverable. Không audit hoặc tạo deliverable khác từ `./docs-app/`. Không có file `.md`
  nào thì không có gì để làm — dừng lại và nói rõ, đừng bịa sơ đồ.
- **CHỈ ĐỌC.** Stage này không sửa bất cứ file nào dưới `docs/`; nó chỉ GHI
  vào `flows/`.
- Bỏ qua các file phụ trợ không phải nội dung nghiệp vụ (`*.changes.json`,
  `*.notes.json`, `review/index.json`, `review/summary.md`, `*.slice.md`).

## Bước 1 — nhận diện luồng

Một **luồng** là một chuỗi thao tác có mục tiêu nghiệp vụ rõ ràng, đi từ lúc
người dùng bắt đầu tới lúc đạt (hoặc không đạt) mục tiêu đó — ví dụ "Đăng
nhập", "Tạo mới nhân viên", "Duyệt đơn nghỉ phép". Dấu hiệu trong tài liệu:
một mục mô tả các bước thao tác, một bảng luồng, một sơ đồ, một danh sách
"Bước 1/2/3…", hoặc phần mô tả màn hình kèm điều kiện hợp lệ và thông báo lỗi.

- Một tài liệu có thể chứa NHIỀU luồng; một luồng cũng có thể trải trên nhiều
  mục của cùng một tài liệu.
- Đừng cắt vụn: mỗi thao tác lẻ (bấm một nút) KHÔNG phải một luồng.
- Đừng gộp to: hai nghiệp vụ khác mục tiêu là hai luồng, kể cả khi cùng một
  màn hình.

`FLOW-ID` là slug ngắn, chỉ `[A-Za-z0-9-]`, đặt theo dạng `FLOW-<việc>` không
dấu — ví dụ `FLOW-login`, `FLOW-tao-nhan-vien`. Id là duy nhất trong cả dự án.

## Bước 2 — ghi `flows/<FLOW-ID>.flowchart.json`

Ghi ĐÚNG một file cho mỗi luồng, theo schema dưới đây. **Schema là ĐÓNG BĂNG**
— viewer render đúng các field này, **không thêm, không bớt, không đổi tên**.

```json
{
  "id": "FLOW-login",
  "title": "Đăng nhập",
  "source": "docs/2.1.1-urd-quan-ly-nhan-vien.md",
  "nodes": [
    { "id": "n1", "type": "start",    "label": "Trang chủ <tên app>" },
    { "id": "n2", "type": "action",   "label": "Nhập tên đăng nhập + mật khẩu" },
    { "id": "n3", "type": "decision", "label": "Thông tin hợp lệ?" },
    { "id": "n4", "type": "action",   "label": "Hiện thông báo lỗi" },
    { "id": "n5", "type": "end",      "label": "Vào màn hình chính" }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3" },
    { "from": "n3", "to": "n5", "label": "Có" },
    { "from": "n3", "to": "n4", "label": "Không" },
    { "from": "n4", "to": "n2" }
  ]
}
```

- `id`: đúng `FLOW-ID` trong tên file.
- `title`: tên luồng, tiếng Việt, ngắn gọn.
- `source`: đường dẫn file `.md` gốc đã dựng nên luồng này, tương đối từ cwd
  (ví dụ `docs/…md`). Một luồng trải trên nhiều file thì ghi file mô tả
  nó chính.
- `nodes[]`: `id` duy nhất trong file (dùng `n1`, `n2`, …), `type` thuộc tập
  đóng bên dưới, `label` là chữ thuần.
- `edges[]`: `from`/`to` phải là `id` có thật trong `nodes[]`; `label` tuỳ chọn
  (bắt buộc với edge ra khỏi `decision`).

## Đường vào (bắt buộc)

- Node `start` là MÀN GỐC người dùng đang đứng trước khi bắt đầu nghiệp vụ (trang chủ / màn chính của app), KHÔNG phải chữ "Bắt đầu".
- Ngay sau `start` là các node `action` mô tả TỪNG bước điều hướng tới màn của tính năng — ví dụ `"Mở menu Danh mục"` → `"Chọn Nhân viên"` → `"Màn danh sách Nhân viên"`. Mỗi bước một node, đúng thứ tự bấm.
- **Nguồn để biết đường vào, theo thứ tự ưu tiên:**
  1. Câu mô tả cách vào nằm trong chính tài liệu feature (`docs-feature/**`) — ví dụ "Chọn menu Danh mục → Nhân viên".
  2. `docs-app/_index.md` — cây tài liệu toàn App; các cấp thư mục thường PHẢN CHIẾU cấu trúc menu (ví dụ `II. URD Danh mục / 2.1 Danh mục đối tượng / 2.1.3 Quản lý khách hàng` ⇒ Danh mục → Đối tượng → Khách hàng). Mở trang trong `docs-app/` để xác nhận tên menu đúng như tài liệu viết.
- **CẤM BỊA:** chỉ ghi bước điều hướng có căn cứ trong tài liệu. Không suy đoán tên menu, không tự chế "Đăng nhập" nếu tài liệu không nói. Không tìm được căn cứ → giữ đúng một node `start` nhãn `"Bắt đầu"` như cũ VÀ ghi lý do vào `note` của mục tương ứng trong `flows/index.json` (ví dụ `"Chưa xác định được đường vào từ tài liệu"`).
- Đường vào là phần CHUNG của mọi kịch bản trong flow đó — viết một lần ở đầu, không lặp lại giữa flow.

## LUẬT FLOWCHART CHUẨN (bắt buộc)

Sơ đồ này dùng đúng ký pháp flowchart kinh điển — viewer vẽ theo hình dạng
tương ứng với `type`:

| `type` | Hình | Nghĩa |
| --- | --- | --- |
| `start` | Oval | Điểm bắt đầu của luồng |
| `end` | Oval | Điểm kết thúc (thành công hoặc dừng hẳn) |
| `action` | Chữ nhật | Một bước hành động / xử lý |
| `decision` | Hình thoi | Một câu hỏi rẽ nhánh |

Mũi tên (`edges[]`) là hướng đi của luồng: `from` → `to`.

Các luật phải giữ đúng:

1. **`type` CHỈ được là `start` | `end` | `action` | `decision`.** Không có
   loại nào khác.
2. **Đúng MỘT node `start`** mỗi flow, và **≥1 node `end`**. `start` là màn gốc app, không phải nhãn chung chung.
3. **Mọi node đều nằm trên đường đi từ `start`** — không có node mồ côi, không
   có nhánh treo lơ lửng không ai trỏ tới.
4. **Node `decision` có label là CÂU HỎI** (kết thúc bằng dấu `?`), có **≥2
   edge đi ra**, và **MỖI edge ra phải có `label`** nêu điều kiện của nhánh
   (`Có`/`Không`, `Đúng`/`Sai`, `Hợp lệ`/`Không hợp lệ`…). Một nhánh không tên
   là một nhánh người đọc không biết khi nào đi vào.
5. **Node `start` và `action` có tối đa MỘT edge ra**; node `end` **không có
   edge ra nào**. Cần rẽ nhánh thì phải qua một `decision` — đó là chỗ duy
   nhất luồng được chia đôi.
6. **Label ngắn gọn, tiếng Việt, chữ thuần** — không markdown, không HTML,
   không xuống dòng. `action` viết theo lối động từ ("Nhập mã nhân viên"),
   `end` nêu kết cục ("Vào màn hình chính", "Huỷ thao tác").
7. **Không bịa bước tài liệu không nói.** Không suy diễn thêm màn hình xác
   nhận, thông báo lỗi, hay bước OTP chỉ vì "thường là vậy".

## Bước 3 — ghi `flows/index.json`

Một file duy nhất liệt kê mọi luồng đã dựng:

```json
[
  { "id": "FLOW-login", "title": "Đăng nhập", "source": "docs/2.1.1-urd-quan-ly-nhan-vien.md" },
  {
    "id": "FLOW-duyet-don",
    "title": "Duyệt đơn nghỉ phép",
    "source": "docs/2.1.4-urd-nghi-phep.md",
    "note": "Tài liệu không nêu điều gì xảy ra khi người duyệt từ chối — nhánh Không dừng ở đây."
  }
]
```

- Mỗi phần tử: `id`, `title`, `source` — lấy đúng giá trị trong file flowchart
  tương ứng.
- `note` (tuỳ chọn): **chỗ duy nhất để ghi phần tài liệu mô tả mơ hồ.** Tài
  liệu nói không rõ (thiếu nhánh, thiếu kết cục, mâu thuẫn giữa hai mục) thì
  ghi chú ở đây; **KHÔNG đoán và vẽ bừa vào sơ đồ**.
- `index.json` phải liệt kê ĐỦ và ĐÚNG số file `*.flowchart.json` đã ghi —
  không thừa một id không có file, không thiếu một file không có trong index.

## Hard rules

- **Chỉ ghi vào `flows/`** — `flows/<FLOW-ID>.flowchart.json` và
  `flows/index.json`. Không ghi vào `docs/`, không ghi vào `review/`.
  `flows/` nằm ở gốc thư mục workflow, KHÔNG lồng trong `review/`: lồng vào đó
  thì một lần chạy lại bước review sẽ xoá sạch sơ đồ.
- **Schema đóng băng.** Không thêm field (`x`, `y`, `swimlane`, `screenId`…),
  không đổi tên field, không đổi tập giá trị `type`. Viewer đọc đúng schema
  trên; một field lạ hoặc một `type` lạ làm sơ đồ không render được.
- **Không luồng nào thì không tạo file rỗng.** Tài liệu thuần định nghĩa dữ
  liệu, không mô tả thao tác nào → nói rõ là không tìm thấy luồng, đừng nặn ra
  một sơ đồ ba node cho có.
- **Không review, không sửa tài liệu.** Phát hiện tài liệu sai/thiếu thì ghi
  `note` trong `index.json`; đó là việc của bước review chạy sau, không phải của
  bước này.
- File-only: không đẩy bất cứ gì lên KGS.
