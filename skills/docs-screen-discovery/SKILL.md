---
name: docs-screen-discovery
description: |
  Stage `dr-screens` ("Phát hiện màn hình") of the `docs-review` workflow —
  runs AFTER `dr-docs` (ingest) and `dr-flow` ("Đánh giá luồng UX"), BEFORE
  `dr-comp` ("Màn hình → Component"). PRDs written in free prose (headings
  like "2.1 Mua SIM" with no `MH`/`SCR` code) confuse a deterministic regex
  scan: a heading that only describes ONE PART of a screen (a "Voucher"
  block, a tab, a small popup nested under "2.1 Mua SIM") gets promoted into
  its OWN screen. Your job: read every ingested feature document end to end
  (plus `flows/` when present) and author the AUTHORITATIVE screen list for
  the whole feature — which headings/blocks are real, standalone screens and
  which are just a part of a bigger screen — so `dr-comp` no longer has to
  guess. Activate when the user runs the "Phát hiện màn hình" pipeline or
  asks which headings in a PRD/URD are actual screens vs. just a section of
  one.
triggers:
  - "phát hiện màn hình"
  - "danh sách màn hình thật"
  - "màn hình hay chỉ là một phần"
  - "heading nào là một màn hình"
  - "screen discovery"
  - "docs screen discovery"
od:
  mode: utility
  category: ux-research
---

# docs-screen-discovery — lập danh sách màn hình THẬT của tài liệu (`docs-review`)

> **TỪ 2026-08-27 bước này đã GỘP vào `docs-screen-flow`** (dr-flow ghi
> `screens.json` v2, daemon sinh `screens-discovered.json` + `comp/_screens.json`).
> Chỉ chạy tay bước này khi tài liệu KHÔNG có luồng để vẽ.

Bạn là bước **Phát hiện màn hình** của workflow `docs-review`, chạy NGAY SAU
`dr-flow` ("Đánh giá luồng UX") và TRƯỚC `dr-comp` ("Màn hình → Component").
Kết quả của bạn là nguồn **có thẩm quyền** — `dr-comp` đọc thẳng file bạn ghi
thay vì tự quét heading bằng regex; nếu bạn bỏ sót hay khai sai, `dr-comp` sẽ
sai theo, nên đọc kỹ TOÀN BỘ tài liệu trước khi quyết, đừng chỉ lướt heading.

## Vì sao bước này tồn tại

Một quét tất định theo khuôn (`MH1`/`SCR-001`, mã mục nhiều cấp `2.1`/`6.1.1`,
dòng in đậm, hàng bảng "Danh sách màn hình"…) chỉ đuổi kịp khuôn ĐÃ THẤY. Với
PRD tự do — heading kiểu `## 2.1 Mua SIM` rồi bên trong lại có `### Voucher`,
`### Thông tin gói cước` như các mục con mô tả CHI TIẾT của cùng một màn — quét
regex không phân biệt được "heading con là một PHẦN của màn cha" với "heading
con là một màn hình MỚI, riêng biệt". Bạn đọc hiểu ngữ cảnh để phân biệt đúng
hai trường hợp đó; daemon sẽ tin nguyên văn danh sách bạn khai (đối chiếu tất
định bằng `anchorText`, không suy diễn hộ).

## Input (từ cwd của dự án)

- **Mọi trang tài liệu `.md` của feature** (`docs-feature/*.md` hoặc
  `docs/*.md` — kickoff liệt kê chính xác đường dẫn). Đọc TOÀN VĂN từng
  trang, không chỉ phần đầu.
- **`comp/_screen-candidates.json`** (khi kickoff nhắc tới) — gợi ý daemon tự
  quét tất định (regex). Đây là tín hiệu **YẾU NHẤT** và thường **LIỆT KÊ DƯ**:
  nó nâng MỌI mục đánh số nằm dưới bất kỳ chương nào có chữ "giao diện"/"màn
  hình" trong tiêu đề (vd cả chương "Khung giao diện sơ bộ") thành candidate —
  nên các trường của form, khối con, bước nhỏ cũng lọt vào danh sách. **KHÔNG
  BAO GIỜ lấy SỐ LƯỢNG candidate của nó làm số màn**; chỉ dùng làm điểm khởi
  động rồi cắt bớt theo các tín hiệu mạnh hơn (xem "Đếm số màn theo tài liệu").
- **`flows/index.json` + `flows/*.flowchart.json`** (khi `dr-flow` đã chạy) —
  cho biết luồng nào đi qua màn nào; dùng để xác nhận thêm một heading có phải
  một màn hình thật (nó xuất hiện như một bước hành động trong luồng) hay chỉ
  là chi tiết trong một màn khác.

## Nhiệm vụ

Với MỖI trang tài liệu, phân loại từng heading/mục vào một trong BA loại:

1. **Màn hình THẬT** — một giao diện người dùng nhìn thấy trọn vẹn, điều
   hướng tới được (từ luồng, từ một nút bấm, từ mục lục) và đứng độc lập với
   các màn khác. Ghi vào `pages[].screens[]`.
2. **KHỐI BỔ SUNG của một màn khác** (lỗi BA hay mắc: đặt một khối mô tả
   THÊM cho màn X thành một mục/heading riêng — ví dụ "Voucher" là chi tiết
   của màn "Mua SIM du lịch" chứ không phải một màn mới) — LỒNG dưới màn cha,
   KHÔNG đưa vào `excluded[]`: `pages[].screens[].blocks: [{ name, anchorText,
   why? }]`. Dấu hiệu nhận biết:
   - **Không có luồng vào/ra riêng** — không ai "điều hướng tới" nó như một
     điểm đến độc lập trong luồng.
   - Nó là **thành phần/thông tin/trạng thái PHỤ** của một màn ĐÃ liệt kê ở
     `screens[]` (một tab con, một khối dữ liệu, một trạng thái/badge…).
   - Nội dung mô tả **element/nội dung THÊM cho màn đó**, KHÔNG phải điều
     hướng dẫn sang một màn mới.
   `anchorText` của block cũng phải là **một dòng chép nguyên văn DUY NHẤT**
   trong trang, cùng luật với `anchorText` của màn thật (xem dưới) — và block
   có thể nằm **RỜI ở chỗ khác** trong tài liệu, không cần liền kề màn cha.
3. **Mục tài liệu THUẦN** — không phải màn, cũng không phải khối bổ sung của
   màn nào (mục lục, mô tả nghiệp vụ, bảng thuật ngữ, "Danh sách màn hình",
   "Phạm vi", "Ngoài phạm vi", "Quy tắc", "Luồng màn hình"…) → đưa vào
   `excluded[]` kèm lý do, như cũ.

### Đếm số màn theo tài liệu (ĐỘNG — mỗi tài liệu một kiểu)

Số lượng màn **KHÔNG** suy ra từ số heading đánh số, càng không từ số candidate
regex. Mỗi tài liệu có cách khai màn riêng — hãy tự đọc ra "nguồn thẩm quyền"
của CHÍNH tài liệu đó rồi đối chiếu, theo thứ tự ưu tiên:

1. **Bảng/phụ lục liệt kê màn của tài liệu** (nếu có) — nhiều PRD có "Phụ lục",
   "Danh sách màn hình", "Danh mục màn hình", bảng wireframe/mockup, hoặc mục
   liệt kê đầu chương nêu ĐÍCH DANH các màn. Khi tài liệu tự liệt kê màn như
   vậy, đó là tín hiệu MẠNH NHẤT cho cả SỐ LƯỢNG lẫn TÊN — danh sách cuối của
   bạn phải khớp nó; lệch thì phải có lý do rõ (bảng bỏ sót/ghi dư).
2. **Luồng (`flows/`)** — tập các node-màn RIÊNG trong sơ đồ luồng: một màn thật
   thường là một điểm đến có cạnh dẫn tới/đi từ nó.
3. **Quy ước ĐẶT TÊN của chính tài liệu** — nhận ra khuôn tài liệu này dùng cho
   MÀN rồi áp nhất quán: rất nhiều PRD đặt tiền tố màn thật là "Màn hình …",
   "Trang …", "Chi tiết …" và để heading của TRƯỜNG/KHỐI/BƯỚC không có tiền tố
   đó (vd "Mã voucher", "Nhập thông tin", "Địa chỉ nhận hàng"). Đừng hard-code
   một tiền tố cố định — đọc ra quy ước của tài liệu đang xử lý và dùng nó.
4. Cuối cùng mới tới đọc hiểu từng section + candidate regex (yếu nhất).

**Mẫu hay gặp — nhóm gộp + trường con:** một mục nhóm (vd "Thông tin chung")
có các mục con đánh số là CÁC TRƯỜNG/BƯỚC của MỘT form nhập liệu ("Nhập thông
tin", "Địa chỉ nhận hàng", "Thông tin xuất hóa đơn", "Mã voucher") → thường là
**MỘT màn** (chính mục nhóm đó) với các mục con là `blocks[]`, KHÔNG phải mỗi
mục con một màn. Chỉ tách thành nhiều màn khi tài liệu/luồng cho thấy chúng là
các BƯỚC ĐIỀU HƯỚNG riêng (mỗi bước một màn có nút chuyển tiếp). Đối chiếu với
phụ lục/luồng ở trên để chốt.

### Luật cốt lõi (quyết định màn THẬT vs. khối bổ sung của màn khác)

- Một heading là KHỐI BỔ SUNG của màn cha, không phải màn riêng, khi nó chỉ
  mô tả một khối/trạng thái/biến thể NẰM TRONG bố cục của màn cha — người
  dùng không "đi tới" nó như một điểm đến độc lập trong luồng, nó luôn xuất
  hiện CÙNG với màn cha (một section trong cùng một màn hình, một tab con,
  một trường/khối dữ liệu được mô tả kỹ hơn).
- Một heading LÀ màn riêng khi: tài liệu/luồng cho thấy người dùng phải
  **điều hướng tới** nó (một nút, một bước trong sơ đồ luồng dẫn sang nó) VÀ
  nó có bố cục/nội dung của MỘT giao diện đầy đủ (không chỉ một trường hay một
  khối nhỏ) — kể cả khi đó là một popup/bottom-sheet/dialog, miễn nó là một
  "màn" độc lập trong flow, không phải chỉ một chi tiết hiển thị tại chỗ.
- Nghi ngờ giữa hai khả năng: ưu tiên xem `flows/` — nếu heading đó khớp một
  node hành động RIÊNG trong sơ đồ (có cạnh dẫn tới/đi từ nó), nó là màn thật;
  không có gì trong luồng nhắc tới nó, và nó nằm lồng trực tiếp dưới một màn
  đã nhận diện, coi nó là khối bổ sung của màn cha (`blocks[]`), KHÔNG phải
  `excluded[]`.
- **Trước khi chốt danh sách**, đối chiếu số lượng + tên màn với nguồn thẩm
  quyền của tài liệu (phụ lục/danh mục màn, rồi luồng — xem "Đếm số màn theo
  tài liệu"). Nếu danh sách của bạn nhiều màn hơn phụ lục/luồng, gần như chắc
  chắn bạn đang tách nhầm trường/khối con thành màn — hạ chúng xuống `blocks[]`.
- Không tự bịa/gộp/tách. Không suy diễn màn KHÔNG có trong tài liệu.

### Nhóm biến thể nền tảng (tài liệu đa nền tảng)

Một số tài liệu (vd CR) khai CÙNG một màn nghiệp vụ lặp lại ở nhiều mục nền
tảng khác nhau trong cùng một file — ví dụ bảng "Màn hình MB", bảng "Màn hình
IB", hoặc mục "BO" riêng.

- Màn trùng tên nhưng nằm ở section thuộc NỀN TẢNG KHÁC nhau (MB/IB/BO) là
  HAI biến thể của một màn nghiệp vụ, KHÔNG gộp thành một entry `screens[]`:
  giữ mỗi biến thể một dòng riêng (anchor riêng, mockup riêng), chỉ thêm hậu
  tố nền tảng vào `code` (hoặc vào `name` khi `code` là `null`) — ví dụ
  `SCR-003-APP` / `SCR-003-WEB` — để daemon nhận ra đây là cùng một màn khác
  biến thể chứ không phải trùng lặp do BA gõ lại.
- Kickoff có thể kèm mục **"gợi ý nhóm"** — danh sách cặp tên gần-giống khác
  nền tảng mà daemon tự phát hiện (vd "danh sách lý do" ở MB và "popup danh
  sách lý do hỗ trợ" ở IB). Bạn CHỈ được xác nhận hoặc bác một cặp NẰM TRONG
  danh sách gợi ý đó — KHÔNG tự bịa nhóm mới ngoài danh sách. Khi xác nhận
  (hoặc bác) một cặp, phải nêu `anchorText` NGUYÊN VĂN của CẢ HAI phía (dòng
  bảng/heading khai từng màn) làm bằng chứng; daemon sẽ đối chiếu tất định
  anchor đó có tồn tại trong trang trước khi chấp nhận, cùng luật `anchorText`
  ở trên. Không có mục "gợi ý nhóm" trong kickoff → bỏ qua phần này.

## Output — đúng 2 file

### `docs-review/screens-discovered.json`

```json
{
  "schema_version": 1,
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "pages": [
    {
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "screens": [
        {
          "code": null,
          "name": "Mua SIM",
          "anchorText": "## 2.1 Mua SIM",
          "blocks": [
            {
              "name": "Voucher",
              "anchorText": "### Voucher",
              "why": "Khối nhập mã giảm giá bên trong màn Mua SIM — không có luồng vào/ra riêng, chỉ là thông tin phụ của màn này."
            }
          ]
        },
        { "code": "SCR-002", "name": "Chọn gói cước", "anchorText": "### 4.2 SCR-002 Chọn gói cước" }
      ]
    }
  ],
  "excluded": [
    {
      "name": "Danh sách màn hình",
      "source": "docs-feature/2.1-PRD-Mua-SIM.md",
      "reason": "Tiêu đề mục liệt kê của tài liệu, không mô tả một giao diện cụ thể."
    }
  ],
  "groupSuggestions": [
    {
      "suggestionId": "danh-sach-ly-do__mb-ib",
      "decision": "confirm",
      "anchorTextA": "| Danh sách lý do | ... |",
      "anchorTextB": "**Popup danh sách lý do hỗ trợ**",
      "why": "Cùng luồng nhắc lý do hỗ trợ, chỉ khác cách trình bày MB/IB."
    }
  ]
}
```

Luật field (đối chiếu tất định — sai một trong các luật dưới, màn đó bị daemon
loại khi `dr-comp` đọc lại, không cảnh báo riêng ở bước này):

- `source`: đúng đường dẫn `.md` kickoff liệt kê, chép nguyên văn.
- `anchorText`: chép **NGUYÊN VĂN CẢ MỘT DÒNG** của trang (heading, dòng in
  đậm, hàng bảng — bất kỳ dòng nào), và dòng đó phải **DUY NHẤT** trong toàn
  trang (khớp y nguyên sau khi trim khoảng trắng đầu/cuối, ngoài code fence).
  Mỗi màn một `anchorText` riêng — không dùng chung một dòng cho hai màn khác
  nhau, không ghép nhiều dòng làm một anchor.
- `code`: mã màn tài liệu đã ghi (giữ nguyên, kể cả hậu tố) nếu có. Tài liệu
  không có mã → để `null`, **KHÔNG BỊA MÃ**; daemon tự đánh `X1`, `X2`… theo
  thứ tự dòng anchor trong trang. Màn là một biến thể nền tảng của cùng một
  màn nghiệp vụ (xem "Nhóm biến thể nền tảng" trên) → thêm hậu tố `-APP`/`-WEB`
  vào cuối mã (`code` là `null` thì thêm vào cuối `name` thay vì bịa mã) —
  không gộp hai biến thể thành một entry `screens[]`.
- `name`: tên màn ngắn gọn, đúng chữ tài liệu dùng (không diễn giải lại).
- `why` (tuỳ chọn): một câu ngắn giải thích vì sao đây là màn thật, hữu ích
  khi ranh giới không hiển nhiên (vd một popup).
- `blocks[]` (tuỳ chọn): khối bổ sung của MÀN NÀY mà bạn thấy BA đặt sai chỗ
  (loại 2 ở trên) — mỗi phần tử `{ name, anchorText, why? }` cùng luật với
  màn: `anchorText` chép nguyên văn MỘT DÒNG DUY NHẤT trong trang (được phép
  nằm RỜI, không cần liền kề màn cha); `name` là tên khối; `why` tuỳ chọn giải
  thích vì sao nó là khối bổ sung chứ không phải màn riêng. Không có khối nào
  → bỏ hẳn field (đừng ghi `"blocks": []`).
- `excluded[].reason`: bắt buộc, một câu ngắn nêu rõ vì sao KHÔNG phải màn
  cũng không phải khối bổ sung của màn nào.
- `excluded[].partOf`: hiếm khi cần — chỉ dùng cho trường hợp không rõ ràng
  thuộc màn cha nào cụ thể dù không phải mục tài liệu thuần; trường hợp bạn đã
  xác định rõ màn cha thì dùng `blocks[]` (loại 2), không dùng `excluded` +
  `partOf` nữa.
- Mỗi trang trong `pages[]` **chỉ liệt kê MỘT LẦN** trong mảng `pages`; gộp
  toàn bộ màn của trang đó vào `screens[]` của đúng một mục.
- `groupSuggestions[]` (tuỳ chọn, chỉ khi kickoff có mục "gợi ý nhóm"): mỗi
  phần tử ứng với ĐÚNG MỘT gợi ý trong kickoff — `suggestionId` chép nguyên
  văn id daemon đưa ra; `decision`: `"confirm"` (đúng là hai biến thể của
  cùng một màn) hoặc `"reject"` (không liên quan); `anchorTextA`/
  `anchorTextB`: chép nguyên văn dòng khai màn của MỖI phía, cùng luật
  `anchorText` ở trên (duy nhất trong trang của nó); `why` tuỳ chọn. Không có
  gợi ý nào trong kickoff, hoặc không xác nhận/bác cặp nào → bỏ hẳn field.
  Không tự thêm phần tử ứng với cặp KHÔNG có trong danh sách gợi ý.

### `docs-review/screens-discovered.md`

Bản người-đọc, tóm tắt cùng nội dung trên: theo từng trang, liệt kê danh sách
màn hình THẬT (tên + mã); màn nào có khối bổ sung thì LỒNG chúng dưới màn cha
bằng sub-bullet, ví dụ:

```
- Mua SIM
  - Khối bổ sung: Voucher
```

danh sách mục tài liệu bị loại kèm lý do (`excluded[]`); và nếu kickoff có
"gợi ý nhóm", một mục ngắn nêu cặp nào bạn xác nhận/bác kèm `anchorText` hai
phía — để người review hiểu nhanh quyết định của bạn mà không cần đọc JSON.

## Hard rules

- **Chỉ ghi đúng 2 file**: `docs-review/screens-discovered.json` +
  `docs-review/screens-discovered.md`. Không ghi vào `comp/`, không sửa
  `docs/`, `docs-feature/`, `flows/`, `criteria/`.
- **Không sửa nội dung tài liệu gốc** — bước này chỉ ĐỌC và phân loại.
- **Không đẩy gì lên KGS, không push, không tạo commit.** File-only.
- Nghi ngờ mà không có căn cứ đối chiếu được (không tìm ra `anchorText` duy
  nhất) → đừng khai màn đó; thà bỏ sót một màn mơ hồ còn hơn khai một anchor
  daemon không đối chiếu được (bị loại thầm lặng khi `dr-comp` đọc lại).
