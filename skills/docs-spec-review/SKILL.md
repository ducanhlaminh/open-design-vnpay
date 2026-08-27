---
name: docs-spec-review
description: |
  Terminal stage of the `docs-review` workflow (pipeline `dr-review`) — an
  INDEPENDENT workflow from `docs-to-ui` and `docs-to-prd`, with its own docs
  ingest run (`dr-docs`) and its own screen-flow stages (`dr-flow` = "Luồng
  màn hình", `dr-flow-improve` = "Cải thiện luồng"), never sharing output with
  either. The daemon has ALREADY cloned every ingested page into
  `review/docs/<same path>.md` before this skill runs (no LLM needed for that
  step). Review ONE SECTION of one page's CLONE (the daemon fans out per
  heading-section) against an optional user-supplied set of criteria
  (`criteria/*.md` — rule text + a component list) across five lenses:
  ux-writing, flow, gap, edge-case, component. The measuring stick for the
  `flow` lens is the SELECTED screen flow (`flows/SCREEN-FLOW/selection.json`,
  absent = original) summarised by the daemon in
  `review/_screen-flow-context.json` — the BA's original diagram inside the
  document is NOT reviewed any more. The `component` lens only runs when the
  project has `comp/` (kickoff says so) or `criteria/components.md`.
  Embedded mockups/screenshots are illustrative
  only and must not be opened or used as evidence for flow, gap, edge-case, or
  component findings. Do NOT edit the slice text — declare every proposed
  Thêm/Sửa/Xóa as an entry (before/quote/anchor/reason) in a
  `.s<NN>.changes.json` file, and every finding that is not a single
  text-replacement proposal in a `.s<NN>.notes.json` file — the daemon
  validates both and writes the review page as the enriched ORIGINAL; your
  proposals never get baked into the file, only surfaced as highlight+modal.
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

# docs-spec-review — review một trang tài liệu theo bộ tiêu chí, ĐỀ XUẤT chứ không sửa (Terminal, `docs-review`)

Bạn là bước **Review tài liệu** của workflow `docs-review` — độc lập hoàn toàn
với `docs-to-ui` và `docs-to-prd`. Upstream trong CHÍNH workflow này, `dr-docs`
đã nạp tài liệu (Confluence hoặc file `.md` người dùng tải lên) vào `docs/`.
Daemon đã tự động nhân bản MỖI trang sang `review/docs/<đường dẫn gốc>.md`
TRƯỚC KHI bạn chạy — bạn không cần (và không được) tự tạo bản clone.

## Tài liệu bạn đang review là URD/PRD

- **URD (User Requirement Document)** là tài liệu yêu cầu người dùng do BA của
  VNPAY viết cho MỘT tính năng: nó đặc tả nghiệp vụ **làm gì**, không đặc tả
  giao diện trông thế nào. **PRD** cùng họ nhưng ở mức sản phẩm — luật review
  y hệt nhau.
- Cấu trúc điển hình của một URD VNPAY: mục tiêu/phạm vi → luồng nghiệp vụ
  (thường kèm sơ đồ Mermaid/draw.io) → danh sách màn hình (heading dạng
  «Màn hình 1: SCR-001 — Tên màn») → bảng yêu cầu chi tiết theo màn/trường
  (tên trường, kiểu, bắt buộc, validation) → ảnh mockup nhúng chỉ để minh hoạ
  (xem Bước 0.5).
- Review URD nghĩa là soát **ĐẶC TẢ**: chỗ mơ hồ ai-làm-gì, luồng cụt, tính
  năng/màn được nhắc mà không có mô tả, thiếu state lỗi/rỗng/giới hạn — những
  thứ tốn tiền nếu lọt xuống khâu làm sản phẩm. Nó KHÔNG phải biên tập văn
  phong hay soát chính tả (xem Hard rules).

**Bạn chỉ xử lý MỘT SECTION của MỘT trang mỗi lần chạy.** Daemon fan-out stage
này theo section — kickoff nêu đích danh tên heading và khoảng dòng
(`startLine-endLine`) bạn phụ trách, kèm đường dẫn gốc, LÁT CẮT bạn ĐỌC (CHỈ
ĐỌC, không sửa), và hai file output của section. Các section của cùng một
trang chạy **song song**, mỗi lượt đọc một lát cắt riêng, nên bạn không thể
giẫm chân lượt khác. **Bạn KHÔNG còn sửa lát cắt nữa** — mọi Thêm/Sửa/Xóa chỉ
là ĐỀ XUẤT bạn khai trong `changes.json` (Bước 2/3). Daemon ghép các LÁT GỐC
(baseline đã enrich bảng "Cấu thành màn hình" + sơ đồ, KHÔNG có bất kỳ sửa chữ
nào của bạn) thành trang hoàn chỉnh ghi ra cho người đọc; đề xuất của bạn được
gộp cấp trang riêng để web hiển thị bằng highlight + modal, KHÔNG được áp vào
tài liệu.

## Bước 0 — đọc input (từ cwd của dự án)

**Bố cục tài liệu.** Bản gốc theo path kickoff (`docs/…` hoặc `docs-feature/…`) là nguồn sự thật và chỉ đọc. `./docs-app/` không thuộc phạm vi review; chỉ có thể tham khảo sau khi đọc `./docs-app/_index.md`. Dự án legacy dùng `./docs/confluence/`, `./docs/jira/`, `./docs/context/`.

**Lưu ý:** `docs-app/` không thuộc phạm vi review; chỉ review các trang được kickoff nêu.

**Bố cục tài liệu:** review bản gốc theo path kickoff (`docs/…` hoặc `docs-feature/…`) ở chế độ chỉ đọc; `docs-app/` không thuộc phạm vi review.

- **Lát cắt của bạn (ĐỌC TRỌN, CHỈ ĐỌC — KHÔNG sửa):**
  `review/docs/<page>.s<NN>.slice.md` — daemon đã tách sẵn, chứa ĐÚNG và ĐỦ
  nội dung section bạn phụ trách. Đây là NGUỒN để bạn trích nguyên văn
  `before`/`anchor` cho `changes.json` — bạn không còn sửa lát này bằng bất kỳ
  công cụ nào (xem Bước 2). Ref ảnh tương đối vẫn trỏ đúng vì lát nằm cùng
  thư mục với bản clone (daemon nhân bản NGUYÊN cây `docs/` kể cả
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
- **Bản clone cả trang:** `review/docs/<page>.md` — **KHÔNG đọc, CẤM sửa.** Đây
  là bản daemon GHI RA cho người đọc: ghép lại từ các lát BASELINE đã enrich
  (bảng "Cấu thành màn hình" + sơ đồ inline), KHÔNG áp bất kỳ Thêm/Sửa/Xóa
  nào của bạn — đề xuất của bạn chỉ tồn tại trong `changes.json`/`notes.json`,
  web hiển thị chúng bằng highlight + modal. Mọi sửa đổi ghi thẳng vào đây sẽ
  bị ghi đè và mất.
- **Bộ tiêu chí (tuỳ chọn):** `criteria/*.md` — người dùng có thể tải lên
  (`od files upload <proj> <file> --as docs-review/criteria/<name>.md`). Mỗi
  file có thể chứa rule văn bản (ux-writing, flow, gap, edge-case) và/hoặc một
  danh sách component hợp lệ (cho nhóm component bên dưới). **Thiếu
  `criteria/` hoàn toàn KHÔNG phải lỗi** — dùng bộ mặc định ngay dưới đây thay
  vì dừng lại.
- **Luồng màn hình bản ĐÃ CHỌN — ĐỌC ĐẦU TIÊN (file nhỏ):**
  `review/_screen-flow-context.json` — daemon dựng từ `flows/SCREEN-FLOW/`
  theo `selection.json` (vắng = `original`): `variant`
  (`original`|`improved`), `diagram` (file + trang draw.io đang dùng),
  `screens[]` (key/name/anchorText/cell, màn `provenance: "proposed"` chỉ có
  ở bản cải thiện), `edges[]` (`key` = `<from>→<to>`, label, fromName/toName),
  `outcomes[]` (kết cục thành công/lỗi/kết thúc) và `findings[]` (UX-xx của
  bản cải thiện; original → rỗng). Đây là **thước đo duy nhất** cho nhóm
  flow/edge-case (xem Bước 1). Kickoff đã trích sẵn màn/cạnh/kết cục THUỘC
  section của bạn — file này chỉ để tra thêm ngữ cảnh (tên node hai đầu cạnh,
  finding). **File không tồn tại** (dự án chưa chạy dr-flow) → không có thước
  đo luồng: nhóm flow chỉ còn luật mặc định `default#flow`.
- **Sơ đồ gốc BA vẽ trong tài liệu KHÔNG review nữa** (ảnh/attachment
  draw.io, fence mermaid): không nhận xét, không đề xuất sửa thân sơ đồ.
- **Chỉ khi kickoff nhắc (dự án có `comp/`):** bảng "Cấu thành màn hình" đã
  nằm sẵn trong lát (daemon chèn từ `comp/<KEY>.screen.json`) — KHÔNG sửa,
  KHÔNG khai change; mâu thuẫn với tài liệu thì ghi note (Bước 4). Sơ đồ
  mermaid của flow KHÁC (không phải SCREEN-FLOW) có thể đã bị daemon thay bằng
  `flows/<id>/proposed.mmd` — kickoff nêu đích danh, không tự sửa fence/caption.
- **Chỉ đọc file `criteria/` có thật** — liệt kê thư mục `criteria/` trước,
  thiếu file nào (`rules.md`, `components.md`…) thì bỏ qua, đừng thử đọc rồi
  báo lỗi.

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
- **component:** nhóm này KHÔNG có `default#` nào — chỉ chạy khi có
  `comp/<SCREEN-KEY>.screen.json` (kickoff nhắc) hoặc `criteria/components.md`
  (xem Bước 1, nhóm 5). Không có cả hai thì **BỎ QUA nhóm này** — không có gì
  để đối chiếu thì đừng đoán.

Bảy định danh trên là TẬP ĐÓNG — daemon đối chiếu và một `default#…` bịa ra
làm hỏng cả trang, y như một anchor bịa trong `criteria/`.

## Bộ quy tắc Design System

Khi daemon đã stage `criteria/rules.md`, đọc file này trước khi review và dùng anchor thật (`criteria/rules.md#R-...`) cho finding/pass liên quan. File này có thể do người dùng nạp tay HOẶC do daemon tự sinh từ showcase + token của DS, nên ngoài quyết định UX nó còn có thể phủ màu, typography, spacing, elevation/radius, component-usage — trích đúng anchor CÓ THẬT trong file, đừng giả định một tập anchor cố định. Nếu có `criteria/components.md`, dùng nó làm danh mục component hợp lệ đóng; không suy đoán từ trí nhớ. Thiếu một hoặc cả hai file là hợp lệ.

Component trong `criteria/components.md` không có dòng "Mô tả:" → tra
`criteria/components-guide.md` (cùng thư mục, nếu tồn tại) theo đúng anchor
`#figma-…`: đó là mô tả do AI sinh từ phân tích node + ảnh Figma — dùng làm
ngữ cảnh để hiểu component khi viết `finding`/`suggestion` của nhóm
`component`, KHÔNG dùng làm `rule_id` (rule_id vẫn chỉ trỏ
`criteria/components.md#…` / `criteria/rules.md#…`), và khi trích dẫn phải
ghi rõ nguồn "(AI sinh)". File không tồn tại hoặc không có entry cho
component đó → coi như component không có mô tả, xử lý như trước nay.

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
2. **flow** — đối chiếu CHỮ trong lát với **Luồng màn hình bản đã chọn**
   (kickoff "Thước đo luồng" + `review/_screen-flow-context.json`, Bước 0).
   Bốn phép đối chiếu — phép (1) daemon ĐÃ làm, bạn làm (2)(3)(4):

   | # | Đối chiếu | Ai | Kết quả |
   | --- | --- | --- | --- |
   | 1 | Màn trong luồng ↔ mục tài liệu | **daemon** (đã ghi note gap `sys-screen-flow-*`) | **KHÔNG lặp lại** |
   | 2 | Cạnh (chuyển màn / điều kiện rẽ nhánh) ↔ câu điều hướng trong chữ | bạn | lệch → **change** `kind: "flow"`, `rule_id: "flows/SCREEN-FLOW.flowchart.json#<edgeKey>"` (`edgeKey` = `<from>→<to>` như kickoff liệt kê) |
   | 3 | Kết cục / nhánh lỗi có trong luồng ↔ hành vi tài liệu mô tả | bạn | thiếu → **note** `kind: "edge-case"`, `rule_id: "flows/SCREEN-FLOW/screens.json#<KEY>"` (màn liên quan tới kết cục đó) |
   | 4 | (chỉ bản `improved`) finding `UX-xx` ↔ chữ | bạn | chữ chưa phản ánh → **change** `kind: "flow"`, `rule_id: "flows/SCREEN-FLOW/ux-review.json#<UX-id>"` |

   - Chỉ dùng màn/cạnh/kết cục CÓ trong kickoff/context — **không phát minh**
     màn, cạnh hay nhánh ngoài đó. Section không có màn của luồng (kickoff nói
     rõ) → nhóm này chỉ còn luật mặc định `default#flow` (điểm bắt đầu/kết
     thúc, bước có hành động mà thiếu kết quả).
   - **KHÔNG nhận xét sơ đồ gốc BA** vẽ trong tài liệu (ảnh, attachment
     draw.io, fence mermaid) — quyết định sản phẩm: sơ đồ gốc không review.
   - `rule_id` dạng `flows/…` chỉ dành cho kind `flow` / `gap` / `edge-case`
     (+ `flow-diagram` của daemon) — xem Hard rules.
3. **gap** — thiếu mô tả cho một tính năng/màn hình đã được nhắc tới. Màn của
   luồng không có mục mô tả thì daemon đã ghi (phép 1) — không lặp.
4. **edge-case** — thiếu state lỗi/rỗng/loading/giới hạn; kết cục lỗi của
   luồng mà chữ không mô tả → phép (3) ở trên.
5. **component** — **chỉ khi có `comp/` (kickoff nhắc) hoặc
   `criteria/components.md`; không có → bỏ qua hoàn toàn** (không change/note
   nào thuộc nhóm này). Khi có `comp/<SCREEN-KEY>.screen.json` cho màn thuộc
   section của bạn: element mà tài liệu khai khác đề xuất DS (`docType` ≠
   `ds.component`, hoặc `ds: null` kèm `why`) → **GỘP theo đích đề xuất**
   thành ĐÚNG MỘT note/nhóm (`kind: "component"`, `anchor` = `label` element
   đầu nhóm, `rule_id: "criteria/components.md#<ds.anchor>"` nếu có `ds`,
   `finding` kể tối đa 6 trường rồi "+N trường khác", `suggestion` một lần).
   Không lặp lại nội dung đã có trong bảng "Cấu thành màn hình"; element khớp
   DS hoặc thuộc màn ngoài section → không ghi gì. Chỉ có
   `criteria/components.md` (không `comp/`) → dùng nó làm danh mục đóng để
   soát tên component tài liệu nhắc.

Với mỗi tiêu chí có trong `criteria/*.md`, ghi lại `rule_id` (định danh của
rule đó trong file criteria — ví dụ heading hoặc số thứ tự) để trace được đề
xuất vì rule nào.

## Bước 2 — KHÔNG sửa lát cắt; mọi Thêm/Sửa/Xóa CHỈ là ĐỀ XUẤT

**LUẬT CỨNG:**

- **TUYỆT ĐỐI KHÔNG sửa `review/docs/<page>.s<NN>.slice.md`** — không dùng
  Edit, không dùng Write, không dùng lệnh shell (`Set-Content`, `echo`/`cat >`,
  heredoc…), dù bạn thấy "dễ hơn" hay chắc chắn đúng. Lát cắt là NGUỒN CHỈ-ĐỌC
  để bạn trích nguyên văn `before`/`anchor`.
- **Mọi Thêm/Sửa/Xóa là một ĐỀ XUẤT** khai trong `.s<NN>.changes.json` (Bước
  3) — nội dung `quote` sẽ KHÔNG được áp vào tài liệu ghi ra; người dùng xem
  đề xuất qua highlight + modal trên web. Chính vì tài liệu không đổi chữ,
  `before`/`anchor` càng phải chính xác: chúng là toạ độ DUY NHẤT để giao diện
  đặt highlight vào đúng chỗ trong tài liệu.
- **CẤM sửa bản clone cả trang `review/docs/<page>.md`** — nó do daemon dựng
  từ các LÁT BASELINE (đã enrich, KHÔNG có sửa đổi nào của agent) sau khi mọi
  section chạy xong.
- **CẤM sửa bất cứ file nào dưới `docs/`** — kể cả bản gốc của chính trang bạn
  đang review. `docs/` là input read-only tuyệt đối của stage này.
- **TUYỆT ĐỐI không đụng bảng "Cấu thành màn hình" hay fence ` ```mermaid `/
  dòng caption `*flow-diagram — …*`** dù bạn thấy chúng sai/thiếu — đây là
  enrichment do daemon dựng (xem Bước 0). Mâu thuẫn với bảng thì ghi note (Bước
  4); câu chữ mô tả điều hướng lệch với Luồng màn hình bản đã chọn thì khai
  `kind: "flow"` (Bước 1/3) — không tự sửa/đề xuất sửa sơ đồ nào.
- **CẤM chèn bất kỳ chuỗi chú giải nào** (ví dụ `[Rà soát …]`) vào bất cứ đâu
  — nhận xét không diễn đạt được bằng một cặp `before`/`quote` thì đi vào
  `notes.json` (Bước 4).

## Bước 3 — ghi `review/docs/<...>.s<NN>.changes.json`

Ghi đúng MỘT file khai báo ĐỀ XUẤT của section, tại đường dẫn kickoff đã nêu
(bản clone `.md` đổi đuôi thành `.s<NN>.changes.json`, với `NN` là số thứ tự
section đệm 0 hai chữ số — ví dụ section 3 của `review/docs/confluence/a.md` là
`review/docs/confluence/a.s03.changes.json`). Nội dung là một mảng `DocChange`.
Daemon gộp file của mọi section thành `a.changes.json` cấp trang sau khi cả
trang chạy xong — **bạn không tự ghi file gộp đó**. **File này khai báo ĐỀ
XUẤT, không phải nhật ký sửa đổi** (bạn không sửa gì cả) — web hiển thị từng
entry bằng highlight + modal, KHÔNG có gì được áp vào tài liệu. Mỗi change
mang được **cả hai phía**:

- `before`: đoạn văn bản NGUYÊN VĂN hiện có trong lát cắt của bạn — đoạn bạn
  đề xuất Sửa hoặc Xóa. Lát cắt là bản sao nguyên văn của `docs/<page>.md`
  trong khoảng dòng của bạn, nên không cần mở bản gốc để chép.
- `quote`: đoạn văn bản BẠN ĐỀ XUẤT thay thế/bổ sung — chữ MỚI, KHÔNG có mặt
  ở đâu trong tài liệu và SẼ KHÔNG được ghi vào tài liệu; nó chỉ là nội dung
  đề xuất hiển thị trong modal khi người đọc bấm vào highlight.

**Quy ước theo loại thay đổi:**

- **Sửa/thay một đoạn** (trường hợp phổ biến nhất): ghi CẢ HAI — `before` là
  đoạn hiện có trong lát, `quote` là đoạn bạn ĐỀ XUẤT thay vào đó.
- **Bổ sung thuần** (đề xuất thêm câu/đoạn hoàn toàn mới, không thay thế gì):
  chỉ ghi `quote`, bỏ trống `before`.
- **Xoá thuần** (đề xuất bỏ hẳn một câu/đoạn, không thay bằng gì): chỉ ghi
  `before`, bỏ trống `quote`, và **BẮT BUỘC ghi `anchor`** — nguyên văn một
  đoạn trong lát nằm ngay cạnh chỗ bạn đề xuất xoá (câu liền trước hoặc liền
  sau). Vì sao bắt buộc: tài liệu sẽ không đổi chữ, nên `anchor` là toạ độ
  DUY NHẤT để giao diện đặt highlight "đề xuất xoá" vào đúng chỗ trong tài
  liệu — thiếu nó, người đọc không biết đề xuất xoá này nói về đoạn nào. Daemon
  đánh hỏng trang khi thiếu.
- Một change mà cả `before` lẫn `quote` đều rỗng là lỗi.
- `id` chỉ cần duy nhất TRONG section của bạn (ví dụ `c1`, `c2`…); daemon sẽ tự
  namespace thành `s<NN>-<id>` khi gộp cấp trang — trùng `id` trong cùng
  section làm section bị loại.

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

**`change kind: "component"` với `rule_id: "comp/<KEY>.screen.json"` là CỦA
DAEMON, không phải của bạn.** Daemon tự chèn bảng "Cấu thành màn hình" (Bước
0) và tự khai change đó (`quote` = cả bảng, không có `before`) — bạn KHÔNG
sửa bảng này và KHÔNG khai change nào cho nó (xem Bước 2). Nội dung bảng mâu
thuẫn với tài liệu theo cách không diễn đạt được bằng một cặp `before`/`quote`
thì ghi **note** `rule_id: "comp/<KEY>.screen.json"` (Bước 4).

**`kind: "flow-diagram"` là CỦA DAEMON, không phải của bạn.** Bạn **KHÔNG
được tự tạo** một change kind này; daemon đánh hỏng cả trang nếu phát hiện.
Câu chữ mô tả điều hướng lệch với Luồng màn hình bản đã chọn thì khai
`kind: "flow"` (xem Bước 1, nhóm flow), không phải `flow-diagram`.

- `kind`: một trong `ux-writing` | `flow` | `gap` | `edge-case` | `component`
  (`flow-diagram` tồn tại trong schema nhưng CHỈ daemon được dùng — xem trên).
- `severity`: một trong `blocker` | `major` | `minor`.
- `rule_id`: trace về tiêu chí. Có `criteria/` thì dùng anchor trong đó; áp bộ
  mặc định thì dùng đúng một trong bảy `default#…` liệt kê ở Bước 0. Bỏ trống
  vẫn hợp lệ nhưng là lựa chọn kém nhất — một phát hiện không trace được về
  tiêu chí nào thì người đọc không có cách nào phản biện nó.
- `anchor`: bắt buộc với xoá thuần (xem trên); các loại khác không cần. Khi có
  mặt phải tìm thấy nguyên văn trong tài liệu (lát cắt của bạn).
- `doc_refs`: **tối đa 3** đoạn NGUYÊN VĂN lấy từ tài liệu (lát cắt của bạn)
  — mỗi khi `reason` viện dẫn một chỗ KHÁC trong tài liệu ("đoạn trước gọi
  là…", "trái với luồng F-009", "bảng ở mục 2.1 khai khác") thì đoạn được
  viện dẫn đó phải nằm ở đây. UI dựng chúng thành nút nhảy thẳng tới chỗ đó.
  Viện dẫn suông bằng lời buộc người đọc tự đi tìm — đó là lý do trường này
  tồn tại.
- `before` (khi có mặt) phải đủ dài để duy nhất trong trang — daemon dùng nó
  để xác nhận đoạn bạn định thay/xoá thật sự tồn tại trong bản gốc. `anchor`
  và mỗi phần tử `doc_refs` chịu cùng đòi hỏi đó, đối chiếu với tài liệu (lát
  cắt của bạn). `quote` KHÔNG chịu đòi hỏi này — nó là chữ ĐỀ XUẤT, không cần
  (và sẽ không) tồn tại ở đâu trong tài liệu.

### Viết `reason`: đúng MỘT câu, nói VẤN ĐỀ — không tả cách sửa

`reason` trả lời đúng một câu hỏi: **đoạn gốc sai ở chỗ nào, đối chiếu với
tiêu chí nào.** Nhắm dưới 160 ký tự.

- **CẤM tả lại đề xuất của bạn.** Không "nên sửa thành…", "thay bằng…", "bổ
  sung…", "gộp lại…", "nêu rõ…". Người đọc thấy `before → quote` cạnh nhau
  trong giao diện, tô màu từng chữ khác biệt — họ đã biết bạn đề xuất gì rồi.
  Kể lại chính là thứ làm câu lý do dài ra và loãng đi.
- **Một câu, một vấn đề.** Cần nói hai vấn đề thì tách thành hai change.
- **Viện dẫn thì phải kèm `doc_refs`** (xem trên). Không có ngoại lệ.

| Không đạt | Đạt |
| --- | --- |
| "Mô tả cũ không nói rõ ai làm gì và thiếu hành vi sau khi nhấn: tác nhân, quy ước tên file, trạng thái loading khi Server kết xuất và thời điểm đóng popup. Gộp các thông tin này (vốn nằm rải ở dòng trùng lặp cuối bảng) vào đúng dòng của nút." | "Dòng mô tả nút không cho biết ai bấm và chuyện gì xảy ra sau khi bấm." |
| "Thống nhất gọi là 'Xác nhận' thay vì 'OK' như đoạn trước đó dùng." | "Cùng một nút được gọi bằng hai tên khác nhau trong cùng trang." + `doc_refs` trỏ tới đoạn dùng tên kia |

## Bước 4 — ghi `review/docs/<...>.s<NN>.notes.json` (nhận xét không phải một đề xuất sửa chữ)

Đây là đường ra cho **mọi phát hiện không diễn đạt được bằng một cặp
`before`/`quote`**. Trước đây chúng không có chỗ nào để đi, nên hoặc bị bỏ qua
hoàn toàn, hoặc bị nhét vào tài liệu dưới dạng chú giải — cả hai đều sai. Ghi
note khi bạn thấy:

- văn bản yêu cầu dùng overlay/Modal/Drawer sai ngữ cảnh (sai `R-OVERLAY`);
- mỗi NHÓM element (cùng đích đề xuất DS) trong `comp/<SCREEN-KEY>.screen.json`
  (màn thuộc section của bạn) mà tài liệu khai khác đề xuất DS — `docType` ≠
  `ds.component`, hoặc `ds: null` kèm `why` (tài liệu đòi thứ DS không có) —
  **GỘP thành MỘT note cho cả nhóm**, đúng luật ở Bước 1 nhóm 5 (không ghi một
  note mỗi element, không lặp lại thông tin đã có trong bảng "Cấu thành màn
  hình"). **Đừng tự phán lại** từ tài liệu hay từ ảnh;
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
- `id` chỉ cần duy nhất TRONG section của bạn (ví dụ `n1`, `n2`…); daemon sẽ tự
  namespace thành `s<NN>-<id>` khi gộp cấp trang — trùng `id` trong cùng
  section làm section bị loại.
- **Heading rỗng là gap mức `major`** (`kind: "gap"`) — **CHỈ khi đó là heading
  LÁ** (không có mục con nào sâu hơn ngay dưới nó). Một heading rỗng nhưng là
  **MỤC CHA** của các mục con sâu hơn (kickoff nêu rõ khi section của bạn rơi
  vào ca này — "LƯU Ý: heading này là MỤC CHA…") thì nội dung nằm ở mục con,
  **KHÔNG phải gap, KHÔNG ghi note "heading rỗng"** cho nó — làm theo đúng
  những gì kickoff nêu cho section của bạn. Với heading lá rỗng thật sự: ghi
  note — **KHÔNG tự bịa sơ đồ/nội dung vào tài liệu** để "lấp" nó.

Section không có nhận xét nào thì **không cần tạo file** — file thiếu được hiểu
là mảng rỗng, không phải lỗi.

## Hard rules

- **CẤM tạo change chỉ để đề xuất sửa chính tả.** Lỗi gõ, thiếu/thừa dấu tiếng
  Việt, viết hoa/thường không đều, khoảng trắng thừa, sai dấu câu — không cái
  nào được thành một entry trong `changes.json`, dù bạn có nhìn thấy. Nếu một
  câu vừa sai chính tả vừa có vấn đề thật (mơ hồ, sai thuật ngữ), hãy đề xuất
  và khai báo theo vấn đề thật, đừng lấy chính tả làm lý do.

  Vì sao: người đọc bản review cần biết chỗ nào **mơ hồ, sai luồng, hay thiếu
  mô tả** — đó là thứ tốn tiền nếu lọt xuống khâu làm sản phẩm. Một bản soát
  lỗi gõ họ không cần, và vì lỗi gõ thì trang nào cũng có nên nó áp đảo danh
  sách về mặt số lượng, đẩy những phát hiện đáng giá xuống dưới. Thà trả về ít
  change mà mỗi cái đều đáng đọc.
- **Chỉ khai change cho những chỗ bạn THỰC SỰ có ý kiến theo 5 nhóm ở Bước 1**
  — không có cơ chế đối chiếu dòng-đã-đổi nào chạy nữa (bạn không sửa gì trên
  đĩa để đối chiếu), nên daemon tin vào chính danh sách bạn khai. Bỏ sót một
  vấn đề thật là mất phát hiện đó, không phải lỗi kỹ thuật — nhưng khai bừa để
  "cho chắc" cũng không được: xem luật chính tả ở trên và Bước 1 cho phạm vi
  đúng của mỗi nhóm.
- `before` phải thực sự xuất hiện trong bản GỐC/lát cắt — giá trị sai/không
  tồn tại làm hỏng trang. `quote` KHÔNG chịu đòi hỏi này: nó là chữ ĐỀ XUẤT,
  không cần (và sẽ không) tồn tại ở đâu trong tài liệu. `anchor` và mọi phần
  tử `doc_refs` của một change cũng phải xuất hiện trong tài liệu (lát cắt của
  bạn); với note, `doc_refs` đối chiếu bản GỐC. Trích sai một chữ ở
  `before`/`anchor`/`doc_refs` là hỏng trang, nên hãy COPY nguyên văn thay vì
  gõ lại.
- **Xoá thuần bắt buộc có `anchor`.** Không có `quote` thì `anchor` là toạ độ
  duy nhất để giao diện đặt highlight "đề xuất xoá" vào đúng chỗ của nó trong
  tài liệu; thiếu nó, đề xuất xoá không neo được vào đâu trong thứ người đọc
  nhìn thấy.
- **`reason` là MỘT câu nêu vấn đề, không phải bản tường thuật đề xuất của
  bạn.** Cấm "nên sửa thành…", "thay bằng…", "bổ sung…". Diff `before → quote`
  đã hiển thị nguyên vẹn cạnh câu lý do, tô màu tới từng chữ — kể lại nó chỉ
  làm câu dài ra và đẩy phần "sai ở đâu" xuống cuối.
- **Viện dẫn thì phải kèm `doc_refs`.** Mọi câu lý do nhắc tới một chỗ khác
  trong tài liệu ("đoạn trước", "luồng F-009", "bảng mục 2.1") phải mang theo
  nguyên văn đoạn đó, tối đa 3. Không có nó, người đọc phải tự dò cả trang để
  kiểm chứng một khẳng định — và phần lớn sẽ không dò.
- **KHÔNG tự ghi `review/index.json` hay `review/summary.md`** — daemon gộp
  kết quả của mọi trang vào hai file đó sau khi tất cả các lượt chạy xong.
  Bạn chỉ ghi hai file của đúng section mình được giao.
- **CẤM chèn bất kỳ chuỗi chú giải nào vào bất cứ đâu** — đặc biệt là
  `[Rà soát …]`. Bạn không sửa lát/bản clone (Bước 2) nên việc này không nên
  xảy ra; nếu daemon vẫn phát hiện chú giải kiểu này trong bản clone, nó
  **đánh hỏng CẢ TRANG** (xoá luôn bản clone lẫn mọi file changes/notes của
  trang đó). Nhận xét không diễn đạt được bằng `before`/`quote` thì ghi note
  (Bước 4), đừng tìm cách viết vào tài liệu.
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
  - **`rule_id` nguồn nội bộ `flows/…` có mảnh `#`** — phần trước `#` là file
    CÓ THẬT trong workflow, phần sau là id trong file (web dùng để tô cell trên
    sơ đồ). Đúng ba dạng:
    `flows/SCREEN-FLOW/screens.json#<KEY>` (màn — kind `gap`/`edge-case`),
    `flows/SCREEN-FLOW.flowchart.json#<from>→<to>` (cạnh, mũi tên unicode `→` —
    kind `flow`),
    `flows/SCREEN-FLOW/ux-review.json#<UX-id>` (finding bản cải thiện — kind
    `flow`). `flows/…` chỉ hợp lệ cho kind `flow` / `flow-diagram` / `gap` /
    `edge-case`; dùng cho `ux-writing`/`component` là lỗi cứng. `UX-id` không
    có trong ux-review chỉ bị cảnh báo, nhưng KEY/edgeKey phải lấy đúng từ
    kickoff/context — không bịa.
- **CẤM tự vẽ/sửa/đề xuất sửa bất kỳ sơ đồ nào** (sơ đồ gốc BA trong tài
  liệu, fence ` ```mermaid ` và caption `*flow-diagram — …*`, sơ đồ Luồng màn
  hình) — kể cả khi bạn thấy sơ đồ sai hoặc thiếu nhánh. Sơ đồ gốc BA KHÔNG
  review; sơ đồ Luồng màn hình là việc của `dr-flow`/`dr-flow-improve`. Câu
  chữ lệch với Luồng màn hình bản đã chọn thì khai `kind: "flow"` (Bước 1/3,
  đây cũng chỉ là đề xuất, không sửa gì trên đĩa).
- **Bảng "Cấu thành màn hình" (chỉ dự án có `comp/`) — daemon tự chèn (Bước
  0) và TỰ QUẢN LÝ toàn bộ nội dung của nó, kể cả hai cột "Vai trò / dùng để"
  và "Ghi chú".** Bạn KHÔNG
  sửa bảng này và KHÔNG khai change nào cho nó (xem Bước 2/3). Nội dung mâu
  thuẫn với tài liệu theo cách không diễn đạt được bằng `before`/`quote` thì
  ghi note `rule_id: "comp/<KEY>.screen.json"` (Bước 4).
  - Cột "Mô tả component" mang hậu tố **"(AI sinh)"** nghĩa là mô tả đó lấy
    từ `criteria/components-guide.md` chứ không phải mô tả gốc trong Figma —
    đây là điều bình thường khi bạn đọc bảng để viết note, KHÔNG phải một
    lỗi.
- File-only: không đẩy bất cứ gì lên KGS.
