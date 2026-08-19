---
name: docs-spec-review
description: |
  Terminal stage of the `docs-review` workflow (pipeline `dr-review`) — an
  INDEPENDENT workflow from `docs-to-ui` and `docs-to-prd`, with its own docs
  ingest run (`dr-docs`) and its own component audit run (`dr-comp`), never
  sharing output with either. The daemon has
  ALREADY cloned every ingested page into `review/docs/<same path>.md` before
  this skill runs (no LLM needed for that step). Review ONE SECTION of one
  page's CLONE (the daemon fans out per heading-section) against an optional
  user-supplied set of criteria (`criteria/*.md` — rule text + a component
  list) across five lenses: ux-writing, flow, gap, edge-case, component. The
  `component` lens is NOT re-derived here — the upstream `dr-comp` stage
  ("Màn hình → Component") already mapped every screen of the feature to the
  Design System and wrote `comp/<SCREEN-KEY>.screen.json` (index in
  `comp/index.json`); read those files and turn each element whose document
  declaration disagrees with the DS proposal (`docType` ≠ `ds.component`, or
  `ds: null` with a `why`) into a note. Embedded mockups/screenshots are illustrative
  only and must not be opened or used as evidence for flow, gap, edge-case, or
  component findings. Edit the clone in place with
  targeted Edit calls, then declare every change made in a
  `.s<NN>.changes.json` file and every finding that cannot be fixed by editing
  text in a `.s<NN>.notes.json` file — the daemon validates both.
  Activate when the user runs the "Review tài liệu" pipeline or asks to
  review a doc against a set of criteria / audit a spec's writing and flows /
  edit a document per house rules.
triggers:
  - "review tài liệu"
  - "docs spec review"
  - "review spec theo tiêu chí"
  - "audit tài liệu"
  - "sửa tài liệu theo bộ tiêu chí"
  - "review document against criteria"
  - "edit spec per rules"
od:
  mode: utility
  category: ux-research
---

# docs-spec-review — review + sửa một trang tài liệu theo bộ tiêu chí (Terminal, `docs-review`)

Bạn là bước **Review tài liệu** của workflow `docs-review` — độc lập hoàn toàn
với `docs-to-ui` và `docs-to-prd`. Upstream trong CHÍNH workflow này, `dr-docs`
đã nạp tài liệu (Confluence hoặc file `.md` người dùng tải lên) vào `docs/`.
Daemon đã tự động nhân bản MỖI trang sang `review/docs/<đường dẫn gốc>.md`
TRƯỚC KHI bạn chạy — bạn không cần (và không được) tự tạo bản clone.

**Bạn chỉ xử lý MỘT SECTION của MỘT trang mỗi lần chạy.** Daemon fan-out stage
này theo section — kickoff nêu đích danh tên heading và khoảng dòng
(`startLine-endLine`) bạn phụ trách, kèm đường dẫn gốc, LÁT CẮT bạn được sửa,
và hai file output của section. Các section của cùng một trang chạy **song
song**, mỗi lượt trên lát cắt riêng, nên bạn không thể giẫm chân lượt khác —
miễn là chỉ sửa lát của mình. Daemon ghép mọi lát lại thành trang hoàn chỉnh
sau khi tất cả chạy xong.

## Bước 0 — đọc input (từ cwd của dự án)

**Bố cục tài liệu.** Bản gốc theo path kickoff (`docs/…` hoặc `docs-feature/…`) là nguồn sự thật và chỉ đọc. `./docs-app/` không thuộc phạm vi review; chỉ có thể tham khảo sau khi đọc `./docs-app/_index.md`. Dự án legacy dùng `./docs/confluence/`, `./docs/jira/`, `./docs/context/`.

**Lưu ý:** `docs-app/` không thuộc phạm vi review; chỉ review các trang được kickoff nêu.

**Bố cục tài liệu:** review bản gốc theo path kickoff (`docs/…` hoặc `docs-feature/…`) ở chế độ chỉ đọc; `docs-app/` không thuộc phạm vi review.

- **Lát cắt của bạn (ĐỌC TRỌN, và là nơi DUY NHẤT được sửa):**
  `review/docs/<page>.s<NN>.slice.md` — daemon đã tách sẵn, chứa ĐÚNG và ĐỦ
  nội dung section bạn phụ trách. Ref ảnh tương đối vẫn trỏ đúng vì lát nằm
  cùng thư mục với bản clone (daemon nhân bản NGUYÊN cây `docs/` kể cả
  `attachments/`) — đừng đụng vào chúng.
- **Mục lục trang (CHỈ ĐỌC):** `review/docs/<page>.outline.md` — heading + khoảng
  dòng của MỌI section, cờ "rỗng"/"có ảnh". Đọc để biết section của bạn đứng ở
  đâu trong trang và phần nào nói về gì.
- **Bản gốc (CHỈ ĐỌC, KHÔNG đọc cả trang):** `docs/<page>.md` — kickoff nêu
  đúng đường dẫn (có thể là `docs-feature/<branch>/…`). Đây là nguồn sự thật,
  không được sửa. Nó dài gấp nhiều lần lát của bạn, nên **không Read cả file**;
  cần ngữ cảnh ngoài section (một thuật ngữ, một luồng được nhắc ở phần khác)
  thì Read đúng khoảng dòng ghi trong mục lục bằng `offset`/`limit`, tối đa
  vài lần.
- **Bản clone cả trang:** `review/docs/<page>.md` — **KHÔNG đọc, CẤM sửa.** Các
  section của cùng một trang chạy SONG SONG, và daemon dựng lại file này bằng
  cách ghép mọi lát sau khi tất cả chạy xong; mọi sửa đổi ghi thẳng vào đây sẽ
  bị ghi đè và mất.
- **Bộ tiêu chí (tuỳ chọn):** `criteria/*.md` — người dùng có thể tải lên
  (`od files upload <proj> <file> --as docs-review/criteria/<name>.md`). Mỗi
  file có thể chứa rule văn bản (ux-writing, flow, gap, edge-case) và/hoặc một
  danh sách component hợp lệ (cho nhóm component bên dưới). **Thiếu
  `criteria/` hoàn toàn KHÔNG phải lỗi** — dùng bộ mặc định ngay dưới đây thay
  vì dừng lại.
- **Sơ đồ luồng đề xuất (chỉ khi kickoff nhắc):** trước khi bạn chạy, daemon đã
  tự đối chiếu `flows/index.json` với trang của bạn và — nếu lát cắt của bạn
  chứa sơ đồ ` ```mermaid ` của luồng đó — tự thay thân sơ đồ bằng
  `flows/<id>/proposed.mmd` và đổi dòng caption ngay trong lát bạn sắp đọc.
  Kickoff nêu đích danh khi việc này xảy ra với lát của bạn, hoặc khi sơ đồ
  của CẢ TRANG đã đổi dù lát của bạn không chứa sơ đồ — đọc
  `flows/<id>/ux-review.json` (`summary` + `findings`) để biết đổi gì. Xem
  Bước 1 nhóm flow và Bước 2.
- **Nháp bảng "Cấu thành màn hình" (chỉ khi kickoff nhắc):**
  `review/_composition/<KEY>.md` — daemon dựng sẵn từ
  `comp/<KEY>.screen.json` cho một màn hình cụ thể nằm trong lát của bạn.
  Kickoff nêu đích danh `<KEY>` và vị trí cần chèn. Xem Bước 2 và Bước 3.

### Bộ tiêu chí mặc định (khi không có `criteria/`)

Mỗi tiêu chí ở đây có một **định danh riêng** (cột `rule_id`) — ghi nó vào
`rule_id` khi bạn áp bộ mặc định, y như khi áp một rule trong `criteria/`.

- **ux-writing:** CHỈ bốn thứ sau, không gì khác:
  1. câu mơ hồ về **ai làm gì** (chủ ngữ ẩn, bị động không rõ tác nhân)
     → `default#ux-writing-chu-ngu`;
  2. **thuật ngữ dùng không nhất quán** — cùng một khái niệm gọi bằng nhiều
     tên khác nhau trong cùng trang → `default#ux-writing-thuat-ngu`;
  3. **viết tắt tối nghĩa** — xuất hiện lần đầu mà không có phần giải nghĩa
     → `default#ux-writing-viet-tat`;
  4. **nhãn nút / thông báo không nói rõ hành động hoặc hậu quả** (ví dụ "OK",
     "Thao tác thất bại" mà không cho biết đã xảy ra chuyện gì và cần làm gì)
     → `default#ux-writing-nhan-nut`.

  **KHÔNG** báo: lỗi chính tả, lỗi gõ, thiếu hoặc thừa dấu tiếng Việt, viết
  hoa/thường không đều, khoảng trắng thừa, sai dấu câu. Xem luật cứng ở phần
  Hard rules.
- **flow** (`default#flow`)**:** mỗi luồng người dùng có điểm bắt đầu + kết
  thúc rõ ràng, không có bước mô tả hành động mà thiếu kết quả/điều hướng
  tiếp theo.
- **gap** (`default#gap`)**:** feature được nhắc tới nhưng không có mô tả hành
  vi (happy path) đầy đủ; màn hình/API được nhắc nhưng không có trong tài liệu.
- **edge-case** (`default#edge-case`)**:** state lỗi, state rỗng, state
  loading, giới hạn dữ liệu (validation, độ dài, số lượng) không được nêu ở
  nơi một hành động có thể thất bại.
- **component:** nhóm này KHÔNG lấy tiêu chí từ bộ mặc định — nó lấy từ
  **kết quả có sẵn** của bước `dr-comp` ở `comp/<SCREEN-KEY>.screen.json`
  (danh sách màn ở `comp/index.json`; xem Bước 1, nhóm 5), nên nó KHÔNG có
  `default#` nào. Không có file `comp/…` thì quay về luật cũ: **BỎ QUA nhóm
  này** khi `criteria/` không cung cấp danh sách component — không có gì để
  đối chiếu thì đừng đoán.

Bảy định danh trên là TẬP ĐÓNG — daemon đối chiếu và một `default#…` bịa ra
làm hỏng cả trang, y như một anchor bịa trong `criteria/`.

## Bộ quy tắc Design System

Khi daemon đã stage `criteria/rules.md`, đọc file này trước khi review và dùng anchor thật (`criteria/rules.md#R-...`) cho finding/pass liên quan. File này có thể do người dùng nạp tay HOẶC do daemon tự sinh từ showcase + token của DS, nên ngoài quyết định UX nó còn có thể phủ màu, typography, spacing, elevation/radius, component-usage — trích đúng anchor CÓ THẬT trong file, đừng giả định một tập anchor cố định. Nếu có `criteria/components.md`, dùng nó làm danh mục component hợp lệ đóng; không suy đoán từ trí nhớ. Thiếu một hoặc cả hai file là hợp lệ.

## Bước 0.5 — tách yêu cầu khỏi ảnh minh hoạ

Mọi `![alt](attachments/…)` trong URD/PRD là **minh hoạ, không phải đặc tả hay
hướng thiết kế**. Không mở ảnh và không suy diễn từ ảnh về flow, màn hình,
component, variant, layout, state, hay khoảng trống của tài liệu. Một chi tiết
chỉ xuất hiện trong mockup không phải là yêu cầu; một yêu cầu chỉ xuất hiện
trong chữ không được coi là thiếu chỉ vì mockup không vẽ nó.

Đánh giá dựa trên văn bản, bảng yêu cầu, tiêu chí Design System và (nếu ingest
đánh dấu rõ) file nguồn `.drawio` cho thứ tự/nhánh nghiệp vụ. Nếu chữ và ảnh
mâu thuẫn, ghi note yêu cầu chủ tài liệu làm rõ/chỉnh phần chữ; không chọn ảnh
làm nguồn đúng và không hướng dẫn đội thiết kế sao chép ảnh.

## Bước 1 — review theo 5 nhóm

Đọc LÁT CẮT của bạn (`review/docs/<page>.s<NN>.slice.md`) cùng mục lục trang,
và đối chiếu với tiêu chí (từ `criteria/` nếu có, hoặc bộ mặc định ở trên)
theo đúng 5 nhóm:

1. **ux-writing** — mơ hồ ai làm gì, thuật ngữ không nhất quán, viết tắt tối
   nghĩa, nhãn nút/thông báo không nói rõ hành động hoặc hậu quả. KHÔNG soi
   chính tả (xem Hard rules).
2. **flow** — luồng thao tác có logic, có điểm kết thúc. Kickoff báo sơ đồ
   luồng của TRANG đã đổi (xem Bước 0) thì đối chiếu câu mô tả nhánh trong lát
   của bạn với bản mới (`flows/<id>/proposed.mmd`, findings ở
   `flows/<id>/ux-review.json`) — câu nào mô tả một nhánh đã đổi mà không còn
   khớp thì sửa, `kind: "flow"`, `rule_id: "flows/<id>/ux-review.json"`. Đây
   là nhóm DUY NHẤT được dùng rule_id dạng `flows/…` — xem Hard rules cho
   sơ đồ chính nó (bạn không được tự sửa fence/caption, chỉ sửa CHỮ mô tả).
3. **gap** — thiếu mô tả cho một tính năng/màn hình đã được nhắc tới.
4. **edge-case** — thiếu state lỗi/rỗng/loading/giới hạn.
5. **component** — **ĐỌC KẾT QUẢ CÓ SẴN, KHÔNG SUY LẠI TỪ ĐẦU.** Bước
   `dr-comp` ("Màn hình → Component") chạy trước bạn đã map từng màn hình của
   feature (lấy từ bước Đánh giá luồng UX) sang Design System và ghi
   `comp/<SCREEN-KEY>.screen.json` (SCREEN-KEY = `<tên-file-md>__<mã màn>`;
   danh sách ở `comp/index.json`, trường `source` cho biết màn thuộc trang
   nào). Mở các file của màn **thuộc trang và section của bạn**, và với mỗi
   `element` mà tài liệu khai một kiểu khác đề xuất DS — `docType` có mà khác
   `ds.component`, hoặc `ds: null` kèm `why` (DS không có thứ tài liệu đòi) —
   ghi **MỘT note** nhóm `component` ở Bước 4:

   | Trường của note | Lấy từ |
   | --- | --- |
   | `kind` | luôn là `"component"` |
   | `anchor` | `label` của element — nguyên văn, phải tìm thấy trong bản GỐC |
   | `rule_id` | `criteria/components.md#<ds.anchor>` nếu có `ds`; không có thì bỏ trống |
   | `finding` | tài liệu khai `docType` nhưng DS dùng `ds.component` (hoặc DS không có) — dựa trên `why` của element |
   | `suggestion` | component/biến thể DS đề xuất (`ds.component` + `ds.variant`), hoặc `fallback` của vai trò trong `comp/_role-map.json` |

   Element có `docType` trùng `ds.component`, hoặc không có `docType` và có
   `ds` → **không ghi gì** (không có mâu thuẫn). Element thuộc màn nằm ngoài
   section của bạn → để cho lượt chạy của section đó.

   **Vì sao đọc file thay vì tự phán:** `dr-comp` đã map màn hình vào Design
   System một lần cho cả feature. Một nguồn dữ liệu duy nhất giữ kết luận nhất
   quán giữa các section mà không biến ảnh minh hoạ thành hướng thiết kế.

   **Không có file `comp/…`** (dự án chạy từ trước khi có bước `dr-comp`) →
   quay về luật cũ: chỉ làm nhóm này khi `criteria/` có danh sách component,
   không có thì **bỏ qua hoàn toàn** (không tạo change/note nào thuộc nhóm
   `component`) — không có gì để đối chiếu thì đừng đoán.

Với mỗi tiêu chí có trong `criteria/*.md`, ghi lại `rule_id` (định danh của
rule đó trong file criteria — ví dụ heading hoặc số thứ tự) để trace được sửa
vì rule nào.

## Bước 2 — sửa vào LÁT CẮT của bạn

**LUẬT CỨNG:**

- **Chỉ sửa `review/docs/<page>.s<NN>.slice.md`** — lát cắt kickoff giao cho
  bạn. Đó là toàn bộ phạm vi bạn được đụng vào.
- **Dùng Edit để sửa từng chỗ một** — mỗi thay đổi là một lời gọi Edit nhắm
  đúng đoạn cần sửa.
- **CẤM dùng Write để ghi đè cả file** — kể cả khi bạn thấy "dễ hơn" viết lại
  toàn bộ. Ghi đè cả file làm mất khả năng đối chiếu dòng-đã-đổi ở bước
  validate của daemon (multiset dòng), và làm hỏng mọi phần không liên quan
  đến review.
- **CẤM sửa bản clone cả trang `review/docs/<page>.md`** — các section chạy
  song song và daemon dựng lại file đó từ mọi lát sau khi tất cả xong; ghi vào
  đó là ghi vào thứ sắp bị thay thế.
- **CẤM sửa bất cứ file nào dưới `docs/`** — kể cả bản gốc của chính trang bạn
  đang review. `docs/` là input read-only tuyệt đối của stage này.
- **Giữ nguyên frontmatter và mọi ref ảnh** có trong lát cắt — chỉ sửa nội dung
  liên quan đến 5 nhóm ở bước 1.
- **TUYỆT ĐỐI không đụng fence ` ```mermaid ` hay dòng caption `*flow-diagram
  — …*`** dù nó nằm trong lát của bạn — daemon đã tự thay bằng sơ đồ đề xuất
  TRƯỚC KHI bạn chạy (xem Bước 0). Sửa vào đó bị coi là "xoá không khai báo"
  và đánh hỏng cả trang.

**Chèn bảng "Cấu thành màn hình" (chỉ khi kickoff nhắc tên một `<KEY>`):**
đọc nháp `review/_composition/<KEY>.md` daemon đã dựng sẵn, rồi Edit CHÈN
NGUYÊN VĂN bảng đó vào lát của bạn, đúng vị trí kickoff nêu (ngay sau dòng
kickoff trích, trước bảng field của màn). **Giữ nguyên số hàng và các cột
`Component DS` / `Biến thể` / `Mô tả component` / `Điều hướng tới` / `Ghi
chú`** — daemon dựng chúng từ `comp/<KEY>.screen.json`, không phải chỗ bạn
suy diễn lại. Cột DUY NHẤT bạn được viết lại là **"Vai trò / dùng để"**: daemon
chỉ điền placeholder (role + trích `why`), bạn đối chiếu với bảng field ngay
bên dưới trong tài liệu rồi viết lại cho đúng, ngắn gọn. Không thêm hàng cho
element không có trong nháp, không bớt hàng có sẵn.

## Bước 3 — ghi `review/docs/<...>.s<NN>.changes.json`

Ghi đúng MỘT file cho phần ĐÃ SỬA của section, tại đường dẫn kickoff đã nêu
(bản clone `.md` đổi đuôi thành `.s<NN>.changes.json`, với `NN` là số thứ tự
section đệm 0 hai chữ số — ví dụ section 3 của `review/docs/confluence/a.md` là
`review/docs/confluence/a.s03.changes.json`). Nội dung là một mảng `DocChange`.
Daemon gộp file của mọi section thành `a.changes.json` cấp trang sau khi cả
trang chạy xong — **bạn không tự ghi file gộp đó**. Mỗi change mang được **cả
hai phía**:

- `before`: đoạn văn bản NGUYÊN VĂN của bản GỐC — lấy từ lát cắt TRƯỚC KHI
  bạn sửa (lát cắt là bản sao nguyên văn của `docs/<page>.md` trong khoảng
  dòng của bạn, nên không cần mở bản gốc để chép) — đoạn bị thay hoặc bị xoá.
- `quote`: đoạn văn bản NGUYÊN VĂN của bản ĐÃ SỬA — lấy từ lát cắt SAU KHI bạn
  sửa (daemon ghép lát vào `review/docs/<page>.md`) — đoạn thay thế hoặc bổ
  sung.

**Quy ước theo loại thay đổi:**

- **Sửa/thay một đoạn** (trường hợp phổ biến nhất): ghi CẢ HAI — `before` là
  câu gốc, `quote` là câu đã sửa. Thiếu `before` ở trường hợp này làm daemon
  coi câu gốc là "xoá không khai báo" và đánh hỏng cả trang.
- **Bổ sung thuần** (thêm câu/đoạn hoàn toàn mới, không thay thế gì): chỉ ghi
  `quote`, bỏ trống `before`.
- **Xoá thuần** (bỏ hẳn một câu/đoạn, không thay bằng gì): chỉ ghi `before`,
  bỏ trống `quote`, và **BẮT BUỘC ghi `anchor`** — nguyên văn một đoạn trong
  bản ĐÃ SỬA nằm ngay cạnh chỗ vừa xoá (câu liền trước hoặc liền sau).
  Vì sao bắt buộc: chỗ xoá không còn chữ nào trong bản đã sửa để neo, nên nếu
  thiếu `anchor` thì người đọc bản review **không nhìn thấy chỗ xoá ở đâu
  trong tài liệu** — nó chỉ còn nằm trong danh sách bên lề. Daemon đánh hỏng
  trang khi thiếu.
- Một change mà cả `before` lẫn `quote` đều rỗng là lỗi.

```json
[
  {
    "id": "c1",
    "kind": "ux-writing",
    "severity": "minor",
    "rule_id": "criteria/rules.md#dong-nhat-thuat-ngu",
    "before": "Người dùng nhấn nút OK để hoàn tất giao dịch.",
    "quote": "Người dùng nhấn nút Xác nhận để hoàn tất giao dịch.",
    "doc_refs": ["Bảng luồng F-003 gọi bước này là **Xác nhận giao dịch**."],
    "reason": "Cùng một nút được gọi bằng hai tên khác nhau trong cùng trang."
  },
  {
    "id": "c2",
    "kind": "gap",
    "severity": "minor",
    "rule_id": "default#gap",
    "before": "Chi tiết xem tài liệu nội bộ (bản 2019).",
    "anchor": "Hệ thống ghi log mọi thao tác sửa hồ sơ nhân viên.",
    "reason": "Trỏ tới một tài liệu không nằm trong phạm vi bàn giao nên người đọc không tra được."
  }
]
```

**Khai change khi chèn bảng "Cấu thành màn hình"** (Bước 2): đúng MỘT change
mỗi `<KEY>` đã chèn — `kind: "component"`, `rule_id: "comp/<KEY>.screen.json"`,
CHỈ có `quote` (nguyên văn CẢ BẢNG vừa chèn, kể cả dòng tiêu đề đậm
`**Cấu thành màn hình…**` và caption `*Nguồn: …*` ở cuối — đây là bổ sung
thuần, giống một đoạn mới), **KHÔNG có `before`**, `reason`: **"Bổ sung cấu
thành màn hình từ kết quả Màn hình → Component."**

**`kind: "flow-diagram"` là CỦA DAEMON, không phải của bạn.** Sơ đồ đề xuất ở
Bước 0/2 do daemon tự thay và tự khai change — bạn **KHÔNG được tự tạo** một
change kind này dù bạn thấy lát của mình chứa sơ đồ đã đổi; daemon đánh hỏng
cả trang nếu phát hiện. Câu chữ mô tả nhánh luồng đổi theo sơ đồ mới thì khai
`kind: "flow"` (xem Bước 1, nhóm flow), không phải `flow-diagram`.

- `kind`: một trong `ux-writing` | `flow` | `gap` | `edge-case` | `component`
  (`flow-diagram` tồn tại trong schema nhưng CHỈ daemon được dùng — xem trên).
- `severity`: một trong `blocker` | `major` | `minor`.
- `rule_id`: trace về tiêu chí. Có `criteria/` thì dùng anchor trong đó; áp bộ
  mặc định thì dùng đúng một trong bảy `default#…` liệt kê ở Bước 0. Bỏ trống
  vẫn hợp lệ nhưng là lựa chọn kém nhất — một phát hiện không trace được về
  tiêu chí nào thì người đọc không có cách nào phản biện nó.
- `anchor`: bắt buộc với xoá thuần (xem trên); các loại khác không cần. Khi có
  mặt phải tìm thấy nguyên văn trong bản ĐÃ SỬA.
- `doc_refs`: **tối đa 3** đoạn NGUYÊN VĂN lấy từ bản ĐÃ SỬA — mỗi khi `reason`
  viện dẫn một chỗ KHÁC trong tài liệu ("đoạn trước gọi là…", "trái với luồng
  F-009", "bảng ở mục 2.1 khai khác") thì đoạn được viện dẫn đó phải nằm ở đây.
  UI dựng chúng thành nút nhảy thẳng tới chỗ đó. Viện dẫn suông bằng lời buộc
  người đọc tự đi tìm — đó là lý do trường này tồn tại.
- Cả `before` và `quote` (khi có mặt) đều phải **đủ dài để duy nhất** trong
  trang (daemon dùng chúng để xác nhận chỗ sửa thật sự tồn tại — `before`
  trong bản gốc, `quote` trong bản clone). Một câu ngắn 4–5 từ trùng lặp ở
  nhiều chỗ trong trang là giá trị KHÔNG hợp lệ cho cả hai trường. `anchor` và
  mỗi phần tử `doc_refs` chịu cùng đòi hỏi đó, đối chiếu với bản ĐÃ SỬA.

### Viết `reason`: đúng MỘT câu, nói VẤN ĐỀ — không tả cách sửa

`reason` trả lời đúng một câu hỏi: **đoạn gốc sai ở chỗ nào, đối chiếu với
tiêu chí nào.** Nhắm dưới 160 ký tự.

- **CẤM tả lại việc bạn đã làm.** Không "đã sửa thành…", "thay bằng…", "bổ
  sung…", "gộp lại…", "nêu rõ…". Người đọc thấy `before → quote` cạnh nhau
  trong giao diện, tô màu từng chữ đổi — họ đã biết bạn làm gì rồi. Kể lại
  chính là thứ làm câu lý do dài ra và loãng đi.
- **Một câu, một vấn đề.** Cần nói hai vấn đề thì tách thành hai change.
- **Viện dẫn thì phải kèm `doc_refs`** (xem trên). Không có ngoại lệ.

| Không đạt | Đạt |
| --- | --- |
| "Mô tả cũ không nói rõ ai làm gì và thiếu hành vi sau khi nhấn: tác nhân, quy ước tên file, trạng thái loading khi Server kết xuất và thời điểm đóng popup. Gộp các thông tin này (vốn nằm rải ở dòng trùng lặp cuối bảng) vào đúng dòng của nút." | "Dòng mô tả nút không cho biết ai bấm và chuyện gì xảy ra sau khi bấm." |
| "Thống nhất gọi là 'Xác nhận' thay vì 'OK' như đoạn trước đó dùng." | "Cùng một nút được gọi bằng hai tên khác nhau trong cùng trang." + `doc_refs` trỏ tới đoạn dùng tên kia |

## Bước 4 — ghi `review/docs/<...>.s<NN>.notes.json` (nhận xét không sửa được)

Đây là đường ra cho **mọi phát hiện không sửa được bằng cách sửa chữ**. Trước
đây chúng không có chỗ nào để đi, nên hoặc bị bỏ qua hoàn toàn, hoặc bị nhét
vào tài liệu dưới dạng chú giải — cả hai đều sai. Ghi note khi bạn thấy:

- văn bản yêu cầu dùng overlay/Modal/Drawer sai ngữ cảnh (sai `R-OVERLAY`);
- mỗi element trong `comp/<SCREEN-KEY>.screen.json` (màn thuộc section của
  bạn) mà tài liệu khai khác đề xuất DS — `docType` ≠ `ds.component`, hoặc
  `ds: null` kèm `why` (tài liệu đòi thứ DS không có). Ánh xạ sang các trường
  của note theo bảng ở Bước 1, nhóm 5; **đừng tự phán lại** từ tài liệu hay từ
  ảnh;
- thiếu hẳn một màn hình hoặc một nhánh luồng mà tài liệu ngụ ý là phải có;
- **sơ đồ rỗng** — heading tồn tại nhưng không có nội dung (kickoff sẽ nêu đích
  danh khi section của bạn rơi vào ca này).

Nội dung là một mảng `DocNote`:

```json
[
  {
    "id": "n1",
    "kind": "component",
    "severity": "major",
    "rule_id": "criteria/rules.md#R-OVERLAY",
    "anchor": "Hệ thống hiển thị hộp thoại xác nhận chuyển khoản",
    "finding": "Tài liệu yêu cầu Modal cho một tác vụ nhiều bước có nhập liệu; R-OVERLAY chỉ cho phép Modal với xác nhận một bước, không có form.",
    "suggestion": "Chuyển sang Drawer hoặc một màn riêng, giữ Modal cho bước xác nhận cuối."
  }
]
```

- `kind` / `severity`: cùng tập giá trị với `changes.json` — không có giá trị
  riêng cho note.
- `anchor`: đoạn văn bản NGUYÊN VĂN lấy từ bản **GỐC**, chỉ để định vị nhận xét
  vào đúng chỗ trong tài liệu. Nó **không** phải chỗ sửa; daemon chỉ kiểm anchor
  có tồn tại trong bản gốc hay không.
- `doc_refs`: tuỳ chọn, **tối đa 3** đoạn NGUYÊN VĂN lấy từ bản **GỐC** — cùng
  luật với `doc_refs` của change ở Bước 3: `finding` viện dẫn chỗ nào khác
  trong tài liệu thì đoạn đó phải nằm ở đây, không viện dẫn suông.
- `finding`: bạn thấy gì và nó sai với cái gì. Cùng tinh thần với `reason`:
  nói vấn đề, không kể lể — nhưng note được dài hơn một câu vì nó phải mô tả
  cả thứ không nhìn thấy trong tài liệu.
- `suggestion`: nên làm gì. Viết đủ cụ thể để người đọc hành động được, đừng
  viết "cần xem lại".
- **Heading rỗng là gap mức `major`** (`kind: "gap"`). Ghi note — **KHÔNG tự
  bịa sơ đồ/nội dung vào tài liệu** để "lấp" nó.

Section không có nhận xét nào thì **không cần tạo file** — file thiếu được hiểu
là mảng rỗng, không phải lỗi.

## Hard rules

- **CẤM tạo change chỉ để sửa chính tả.** Lỗi gõ, thiếu/thừa dấu tiếng Việt,
  viết hoa/thường không đều, khoảng trắng thừa, sai dấu câu — không cái nào
  được thành một entry trong `changes.json`, dù bạn có nhìn thấy. Nếu một câu
  vừa sai chính tả vừa có vấn đề thật (mơ hồ, sai thuật ngữ), hãy sửa và khai
  báo theo vấn đề thật, đừng lấy chính tả làm lý do.

  Vì sao: người đọc bản review cần biết chỗ nào **mơ hồ, sai luồng, hay thiếu
  mô tả** — đó là thứ tốn tiền nếu lọt xuống khâu làm sản phẩm. Một bản soát
  lỗi gõ họ không cần, và vì lỗi gõ thì trang nào cũng có nên nó áp đảo danh
  sách về mặt số lượng, đẩy những phát hiện đáng giá xuống dưới. Thà trả về ít
  change mà mỗi cái đều đáng đọc.
- **Mọi chỗ đã sửa trong bản clone đều phải có một entry tương ứng trong
  `changes.json`, khai đúng phía.** Daemon đối chiếu dòng đã THÊM/ĐỔI (phía
  bản đã sửa) với `quote`, và dòng đã BỊ XOÁ (phía bản gốc) với `before` của
  từng change (chịu được khác biệt khoảng trắng/xuống dòng) — dòng nào không
  được phủ đúng phía sẽ bị daemon đánh hỏng CẢ TRANG (xoá luôn bản clone lẫn
  `changes.json` của trang đó, không phải lỗi có thể sửa tay sau). Với một
  lần sửa chữ bình thường, thiếu `before` là lỗi phổ biến nhất — luôn ghi cả
  hai khi bạn thay một câu bằng câu khác.
- `before` phải thực sự xuất hiện trong bản GỐC, `quote` phải thực sự xuất
  hiện trong bản ĐÃ SỬA — giá trị sai/không tồn tại cũng làm hỏng trang.
  `anchor` và mọi phần tử `doc_refs` của một change cũng phải xuất hiện trong
  bản ĐÃ SỬA; với note, `doc_refs` đối chiếu bản GỐC. Trích sai một chữ là
  hỏng trang, nên hãy COPY nguyên văn thay vì gõ lại.
- **Xoá thuần bắt buộc có `anchor`.** Không có `quote` thì `anchor` là toạ độ
  duy nhất để giao diện đặt đoạn chữ bị xoá vào đúng chỗ của nó trong tài
  liệu; thiếu nó, chỗ xoá biến mất khỏi thứ người đọc nhìn thấy.
- **`reason` là MỘT câu nêu vấn đề, không phải bản tường thuật việc bạn đã
  làm.** Cấm "đã sửa thành…", "thay bằng…", "bổ sung…". Diff `before → quote`
  đã hiển thị nguyên vẹn cạnh câu lý do, tô màu tới từng chữ — kể lại nó chỉ
  làm câu dài ra và đẩy phần "sai ở đâu" xuống cuối.
- **Viện dẫn thì phải kèm `doc_refs`.** Mọi câu lý do nhắc tới một chỗ khác
  trong tài liệu ("đoạn trước", "luồng F-009", "bảng mục 2.1") phải mang theo
  nguyên văn đoạn đó, tối đa 3. Không có nó, người đọc phải tự dò cả trang để
  kiểm chứng một khẳng định — và phần lớn sẽ không dò.
- **KHÔNG tự ghi `review/index.json` hay `review/summary.md`** — daemon gộp
  kết quả của mọi trang vào hai file đó sau khi tất cả các lượt chạy xong.
  Bạn chỉ ghi hai file của đúng section mình được giao.
- **CẤM chèn bất kỳ chuỗi chú giải nào vào bản clone** — đặc biệt là
  `[Rà soát …]`. Daemon quét bản clone và **đánh hỏng CẢ TRANG** nếu phát hiện
  (xoá luôn bản clone lẫn mọi file changes/notes của trang đó).

  Vì sao: chú giải chèn vào giữa một ô bảng markdown **làm vỡ bảng** của tài
  liệu gốc — bản review trở thành thứ không dùng lại được. Và động cơ chèn nó
  luôn là để có chỗ gắn `quote` cho một nhận xét vốn không sửa được bằng chữ;
  loại nhận xét đó giờ đã có đường ra hợp lệ là `notes.json` (Bước 4). Cần bàn
  thì ghi note, đừng viết vào tài liệu.
- **`rule_id` chỉ được dùng anchor CÓ THẬT trong `criteria/`.** Daemon đối
  chiếu với danh sách anchor trích từ heading của các file `criteria/*.md`;
  `rule_id` bịa ra làm hỏng cả trang.
  - `criteria/components.md` là **DANH MỤC component hợp lệ**, không phải bộ
    rule. Nó chỉ được làm `rule_id` cho `kind: "component"`. Dùng nó cho một
    kind khác là lỗi cứng.
  - **Không mượn một rule không liên quan** chỉ để có `rule_id`. Ví dụ
    `R-WCAG` là rule về tương phản màu / mức AA — không dùng nó cho vấn đề
    thuật ngữ, đặt tên, hay câu chữ. Không có rule nào trong `criteria/` khớp
    thì dùng `default#…` của bộ mặc định nếu phát hiện thuộc một trong bảy
    tiêu chí đó; không thuộc cái nào thì **bỏ trống**. Bỏ trống là hợp lệ,
    gán bừa thì không.
  - **`default#…` là tập đóng bảy giá trị** liệt kê ở Bước 0. Daemon kiểm cả
    khi dự án KHÔNG có `criteria/` (bộ mặc định nằm trong chính skill này, nó
    không phụ thuộc thư mục criteria), nên một `default#` bịa ra làm hỏng
    trang y như một anchor bịa.
- **CẤM tự vẽ/sửa sơ đồ mermaid hay dòng caption của nó** (fence
  ` ```mermaid ` và `*flow-diagram — …*` ngay dưới) — kể cả khi bạn thấy sơ đồ
  sai hoặc thiếu nhánh. Đó là việc của bước Đánh giá luồng UX (`dr-flow`),
  daemon đã tự thay bằng bản đề xuất trước khi bạn chạy (xem Bước 0). Bạn chỉ
  được sửa CHỮ mô tả luồng ở nơi khác trong lát, không phải sơ đồ.
- **CẤM thêm hoặc bớt hàng của bảng "Cấu thành màn hình"** khi chèn từ nháp
  `review/_composition/<KEY>.md` (Bước 2) — daemon dựng đúng một hàng cho mỗi
  element của `comp/<KEY>.screen.json`; bạn chỉ được viết lại đúng MỘT cột
  ("Vai trò / dùng để"), giữ nguyên mọi cột và mọi hàng khác.
- File-only: không đẩy bất cứ gì lên KGS.
