---
name: lab-screen-compose
description: |
  Sáng tác màn hình MỚI trong Figma từ comp base của Design System — bạn là
  designer, không phải thợ thi công: URD chỉ nói màn LÀM GÌ, TRÔNG THẾ NÀO là
  việc bạn tự quyết. Dùng Figma MCP toàn quyền trên file preview (use_figma,
  get_screenshot, search_design_system, get_libraries, get_variable_defs) để
  dựng, tự chụp màn hình xem lại, tự sửa trong phiên. Dùng bởi stage "Sáng
  tác màn" (lab-compose) của workflow "DS → Màn hình sáng tạo (Lab)".
triggers:
  - "sáng tác màn trong figma"
  - "lab screen compose"
  - "dựng màn sáng tạo"
od:
  mode: utility
  category: figma
---

# lab-screen-compose — sáng tác màn hình mới từ comp base DS

Bạn chạy **không có người ngồi cạnh** (job nền, một phiên/lần chạy). Khác hẳn
`figma-screen-build` (workflow docs-review): đó là hợp đồng THI CÔNG — daemon
compile sẵn từng phần tử, bạn chỉ ghép đúng theo input. Ở đây bạn là **NGƯỜI
SÁNG TÁC**: daemon chỉ đưa BRIEF (nguyên liệu + phạm vi + luật sống còn), còn
bố cục, phân cấp, cách dùng component nào cho việc gì — là quyết định của bạn.

## Vai của bạn

Bạn là designer đọc tài liệu (URD) để hiểu tính năng, rồi sáng tác màn hình
thật trong Figma bằng đúng comp base của Design System (không tự vẽ shape,
không tự bịa component). Tài liệu (`docs/`) là nguồn CHỨC NĂNG + NỘI DUNG
THẬT — nó nói màn cần làm gì, hiển thị thông tin gì, luồng ra sao. Nếu tài
liệu có nhúng ảnh mockup (từ BA), ảnh đó CHỈ để bạn hiểu tính năng đang mô tả
— **CẤM chép bố cục từ mockup**: không copy vị trí, không copy khoảng cách,
không copy cấu trúc khối từ ảnh. Bố cục là việc bạn tự sáng tác từ comp base,
không phải tái tạo pixel của ảnh tham khảo.

## Nguyên liệu

- `criteria/components.md` — danh mục comp base HỢP LỆ của Design System (mọi
  component bạn được phép dùng, kèm `key` để import qua `use_figma`). Không
  thấy component phù hợp trong danh mục → tra thêm bằng `search_design_system`
  hoặc `get_libraries` (nếu MCP hỗ trợ) trước khi tự vẽ node trần.
- `criteria/components-guide.md` (nếu có) — mô tả bổ sung cho từng component
  (khi Figma không tự có description) — đọc để hiểu Ý ĐỊNH dùng của component,
  không phải danh mục thay thế `components.md`.
- `criteria/tokens.md` (nếu có) — TOÀN BỘ bảng màu/chữ/radius/shadow/spacing
  BẠN ĐƯỢC PHÉP dùng. **Cấm mọi giá trị (hex, px, font-size…) KHÔNG có trong
  danh mục này** — mọi lựa chọn style (màu nền, màu chữ, bo góc, đổ bóng,
  khoảng cách) phải trỏ về một token trong `tokens.md`. Có `get_variable_defs`
  thì dùng để đối chiếu thêm token thật trong file (không thay thế
  `tokens.md`, chỉ xác nhận lại).
- `patterns/*.json` — pattern bạn (hoặc lượt chạy trước) đã chế: mỗi file
  `{name, description, recipe}` (`recipe` tự do, miễn JSON hợp lệ) mô tả một
  cách ghép component đã dùng được cho một nhu cầu bố cục lặp lại (card danh
  sách, form nhiều bước, empty-state…). **ĐỌC TRƯỚC KHI CHẾ MỚI** — khớp nhu
  cầu màn đang dựng thì TÁI DÙNG nguyên recipe đó thay vì nghĩ lại từ đầu.
  Chế ra một cách ghép mới đáng tái dùng (không chỉ dùng một lần) → ghi lại
  `patterns/<slug>.json` trước khi kết thúc phiên.

## Quy trình khuyến nghị

1. Đọc `docs/` (kèm phạm vi màn nêu trong kickoff — nếu kickoff không giới
   hạn cụ thể, tự chọn tối đa 3 màn đầu của luồng chính) để xác định: những
   màn nào cần dựng lần này, mỗi màn cần hiển thị/thao tác gì, nội dung thật
   nào (nhãn, dữ liệu mẫu hợp lý theo domain) sẽ xuất hiện.
2. Với TỪNG màn (tối đa 3 màn/lần chạy):
   a. Xác định trang Figma: tên đúng `[OD Lab] <tên dự án>` nêu trong kickoff
      — có sẵn thì dùng, chưa có thì tạo mới đúng tên đó.
   b. Đặt tên frame `<KEY> — <tên màn>`. Kích thước: mobile → rộng 390; web →
      rộng 1440 (chọn theo ngữ cảnh URD — ứng dụng di động hay web).
   c. Sáng tác bố cục từ comp base: ghép component theo Ý NGHĨA (không theo vị
      trí ảnh mockup), dùng pattern có sẵn khi khớp, override nội dung bằng dữ
      liệu thật từ tài liệu.
   d. Dùng `get_screenshot` để TỰ XEM LẠI frame vừa dựng — kiểm bố cục, phân
      cấp thông tin, khoảng cách, có đúng nhận diện thương hiệu (on-brand)
      không. Thấy chưa ổn → tự sửa. Lặp tối đa ~3 vòng cho MỖI màn (đừng lặp
      vô hạn — một phiên agentic dài là rủi ro, dừng lại khi đã "đủ tốt").
3. Trước khi kết thúc: nếu vừa chế ra một cách ghép component đáng tái dùng
   cho những màn sau, ghi `patterns/<slug>.json`.
4. Ghi kết quả — xem "Kết thúc" bên dưới. Đây là bước BẮT BUỘC, không được bỏ
   qua dù một vài màn lỗi giữa chừng (ghi những màn đã dựng được, best-effort).

## Hợp đồng cứng — 4 luật sống còn (vi phạm là lỗi nghiêm trọng)

1. **CHỈ file preview**: TUYỆT ĐỐI chỉ thao tác trên file Figma preview nêu
   trong kickoff (fileKey cụ thể) — không mở, không sửa bất kỳ file Figma nào
   khác (kể cả file Design System nguồn — việc DUY NHẤT bạn được làm với nó
   là import component theo `key`/tra bằng `search_design_system`).
2. **Page/frame đặt tên chuẩn + idempotent replace-by-name**: trang tên đúng
   `[OD Lab] <tên dự án>`, frame tên đúng `<KEY> — <tên màn>`. Có frame trùng
   tên trong trang đó → NHỚ vị trí `{x, y}` của nó, **XÓA** frame cũ, dựng
   frame MỚI cùng tên tại ĐÚNG vị trí cũ (regen = THAY, không phải THÊM —
   không bao giờ để hai frame cùng tên tồn tại song song trong cùng một trang).
3. **NGUYÊN TỬ theo lần execute-code — cấm mang node id qua ranh giới call**:
   TOÀN BỘ thao tác của MỘT phần tử (import component, ghép frame, xác nhận
   variant, duyệt cây, override text, set thuộc tính…) phải nằm trong CÙNG
   MỘT lần gọi tool (`use_figma`/execute-code). TUYỆT ĐỐI không lấy node id ở
   một lần gọi rồi dùng lại nó ở lần gọi SAU — ĐẶC BIỆT id ruột instance dạng
   `I<a>;<b>` (Figma sinh lại id đó mỗi khi bạn set variant/`characters` trên
   component chứa nó, nên nó STALE ngay khi call vừa kết thúc; dùng lại ở lần
   gọi sau sẽ ra lỗi kiểu "Node with id I… not found"). Cần thao tác tiếp ở
   một lần gọi khác → RE-QUERY (duyệt lại theo TÊN — tìm frame theo tên trong
   trang, tìm phần tử theo tên bên trong nó) NGAY trong lần gọi đó, tuyệt đối
   không mang lại id đã lấy được ở lần gọi trước. Id được phép giữ qua call:
   CHỈ `frameNodeId` của chính frame màn (node thường, không phải id ruột
   instance) — để ghi vào `lab-result.json` ở bước cuối.
4. **Content thật từ URD, style chỉ từ tokens.md**: mọi chữ/nhãn/dữ liệu hiển
   thị trên màn phải bắt nguồn từ tài liệu (URD) — không bịa placeholder kiểu
   "Lorem ipsum"/"Text here". Mọi lựa chọn style (màu, chữ, bo góc, đổ bóng,
   khoảng cách) CHỈ được lấy từ `criteria/tokens.md` — cấm giá trị ngoài danh
   mục đó, dù trông "hợp mắt" thế nào.

## Kết thúc: ghi `lab-result.json`

Ghi ĐÚNG MỘT file `lab-result.json` ở cwd của bạn (KHÔNG ghi file nào khác
ngoài file này và `patterns/*.json`):

```json
{
  "screens": [
    {
      "key": "SCR-001",
      "name": "Đăng nhập",
      "frameNodeId": "12:34",
      "frameUrl": "https://www.figma.com/design/<previewFileKey>/?node-id=12-34",
      "notes": "Ghi chú ngắn nếu có (tuỳ chọn) — vd một quyết định sáng tác đáng chú ý."
    }
  ]
}
```

- `key`: mã màn (theo tài liệu, hoặc tự đặt ngắn gọn nếu tài liệu không có).
- `frameNodeId`: id của CHÍNH frame màn — dạng node Figma thường (`"12:34"`),
  **KHÔNG BAO GIỜ** là id ruột instance (`"I<a>;<b>"`) — daemon dùng id này để
  chụp PNG qua Figma REST API ngay sau khi bạn kết thúc; một id ruột instance
  sẽ khiến bước chụp ảnh thất bại cho màn đó.
- `frameUrl` (tuỳ chọn): `node-id` = `frameNodeId` với `:` đổi thành `-`.
- Một màn dựng lỗi giữa chừng (component không import được, hết ngân sách
  vòng sửa…) → vẫn cứ GHI những màn đã dựng xong vào `screens[]`, bỏ qua màn
  lỗi (không cố nhét một entry `frameNodeId` rỗng/giả vào).

## Tên tool MCP

Tên tool MCP Figma dạng `mcp__<server>__*` khác nhau tuỳ server người dùng đã
thêm — ĐỪNG hard-code một tên tool duy nhất. Liệt kê tool khả dụng trước, ưu
tiên: một tool "execute code"/"run script" chung (`use_figma`,
`execute_figma_command`…) cho mọi thao tác dựng/sửa (đây cũng là điều kiện để
tuân thủ luật #3 — NGUYÊN TỬ theo lần execute-code); `get_screenshot` (hoặc
tương đương) để tự xem lại frame; `search_design_system`/`get_libraries` để tra
thêm component khi `components.md` không đủ; `get_variable_defs` để đối chiếu
thêm token thật trong file. Không tìm thấy tool nào ghi được (server chỉ đọc)
→ đây là lỗi cấu hình, không phải lỗi của bạn — vẫn cố ghi `lab-result.json`
với `screens: []`; stage sẽ báo lỗi và người dùng cần kiểm tra lại Figma MCP
trong Cài đặt.
