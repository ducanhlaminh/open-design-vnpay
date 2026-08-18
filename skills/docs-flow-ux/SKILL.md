---
name: docs-flow-ux
description: |
  Stage `dr-flow` ("Đánh giá luồng UX") of the `docs-review` workflow — an
  INDEPENDENT workflow from `docs-to-ui` and `docs-to-prd`, with its own docs
  ingest (`dr-docs`). Runs BEFORE `dr-comp` and `dr-review`. The daemon has
  already decoded every flow diagram the ingested documents carry (draw.io
  pages, Mermaid flowcharts) into `flows/<FLOW-ID>/` and listed them in
  `flows/_inputs.json`. Read each diagram TOGETHER with the document text,
  judge whether the flow is good UX against a fixed checklist, and — when it
  is not — propose a better flow as SMALL LOCAL EDITS on the original diagram
  (`patch.json` for draw.io, `proposed.mmd` for Mermaid) plus a findings file
  (`ux-review.json`) that links every reason to the cells it concerns. The
  daemon turns your patch into the colour-coded `proposed.drawio`, derives
  `flows/<FLOW-ID>.flowchart.json` (for dr-comp / dr-review) from the SOURCE
  diagram plus your `screens.json`, and rebuilds `flows/index.json`. Activate
  when the user runs the "Đánh giá luồng UX" pipeline or asks to review the
  UX of a screen flow / process diagram in a document.
triggers:
  - "đánh giá luồng ux"
  - "review luồng"
  - "soi ux luồng"
  - "sơ đồ luồng"
  - "sơ đồ luồng màn hình"
  - "flowchart tài liệu"
  - "docs flow ux"
  - "đề xuất luồng tốt hơn"
od:
  mode: utility
  category: ux-research
---

# docs-flow-ux — đánh giá UX của luồng trong tài liệu và đề xuất trên chính sơ đồ gốc (`docs-review`)

Bạn là bước **Đánh giá luồng UX** của workflow `docs-review`. Upstream trong
CHÍNH workflow này, `dr-docs` đã nạp tài liệu vào `docs-feature/` (hoặc
`docs/`). Bước Màn hình → Component (`dr-comp`) chạy SAU bạn và đọc
`flows/*.flowchart.json` để biết màn nào nối sang màn nào; bước Review tài liệu
(`dr-review`) chạy sau cùng và đọc cả `flows/<FLOW-ID>/ux-review.json` của bạn.

Nhiệm vụ của bạn có ba phần, theo đúng thứ tự:

1. **Đọc luồng như tài liệu vẽ** — sơ đồ gốc đã được daemon giải nén, không
   phải vẽ lại từ chữ.
2. **Đánh giá UX của luồng** theo checklist cố định bên dưới, mỗi phát hiện có
   căn cứ trong tài liệu.
3. **Đề xuất luồng tốt hơn (nếu có)** bằng các thao tác SỬA NHỎ trên chính sơ đồ
   gốc — thêm bước, đổi nhãn, đánh dấu bỏ, nối lại cạnh — để daemon tô màu và
   người xem so được "Hiện trạng" với "Đề xuất".

Bạn **không sửa tài liệu, không tự viết XML draw.io, không tự viết
`index.json`, không vẽ lại toàn bộ luồng**.

## Bước 0 — đọc input (từ cwd của dự án)

**Đọc `flows/_inputs.json` TRƯỚC TIÊN.** Nó do daemon sinh ngay trước khi bạn
chạy và liệt kê mọi sơ đồ luồng tìm thấy trong tài liệu:

```json
{
  "flows": [
    {
      "id": "FLOW-mua-sim-du-lich",
      "title": "Mua SIM du lịch",
      "kind": "drawio",
      "source": "docs-feature/…/2.1-PRD-Mua-SIM.md",
      "diagram": "docs-feature/…/attachments/12345-Luong-mua-sim.drawio",
      "page": { "index": 0, "name": "Mua SIM du lịch", "count": 2 },
      "files": { "asIs": "flows/FLOW-mua-sim-du-lich/as-is.drawio", "cells": "flows/FLOW-mua-sim-du-lich/cells.json" },
      "counts": { "nodes": 23, "edges": 31 }
    },
    {
      "id": "FLOW-luong-nguoi-dung",
      "title": "Luồng người dùng",
      "kind": "mermaid",
      "source": "docs-feature/…/21-prd-detail-mua-sim-du-lch.md",
      "diagram": "docs-feature/…/attachments/luong-nguoi-dung.mmd",
      "files": { "asIs": "flows/FLOW-luong-nguoi-dung/as-is.mmd", "svg": "flows/FLOW-luong-nguoi-dung/as-is.svg" },
      "counts": { "nodes": 28, "edges": 35 }
    }
  ],
  "note": "…chỉ có khi không tìm thấy sơ đồ nào…"
}
```

- **`kind: "drawio"`** — đọc `flows/<id>/cells.json`: danh sách cell của trang
  (`id`, `kind` vertex/edge, `label` chữ thuần, `source`/`target` với cạnh,
  toạ độ với node). Đây là "bản đồ" bạn dùng để gọi tên cell trong
  `patch.json` và `ux-review.json`. `as-is.drawio` là XML thuần (đã giải nén)
  — mở khi cần xem style/nhóm, **không sửa, không ghi lại**.
- **`kind: "mermaid"`** — đọc `flows/<id>/as-is.mmd` (nguồn Mermaid); id node
  chính là id trong Mermaid (`A`, `L_Timeout`, …). `as-is.svg` (nếu có) là hình
  tài liệu đã render — chỉ để đối chiếu, không cần mở.
- **Tài liệu**: đọc trang `source` của mỗi luồng (và trang liên quan) — bảng mô
  tả bước, quy tắc nghiệp vụ (BR), bảng màn hình. Sơ đồ nói CÁI GÌ xảy ra; tài
  liệu nói TẠI SAO và ràng buộc gì. Đánh giá phải dựa trên cả hai.
- Bố cục tài liệu: dự án gắn App dùng `./docs-feature/` (nguồn sự thật) và
  `./docs-app/` (pool toàn App, chỉ đọc để đối chiếu, không audit); dự án
  legacy dùng `./docs/`. Bỏ qua `_index.md`, `attachments/`, `*.changes.json`,
  `*.notes.json`, `review/`, `*.slice.md`.
- **Không có `_inputs.json` hoặc `flows` rỗng** → chế độ **text-only** (xem
  cuối tài liệu): tài liệu không có sơ đồ nào, bạn tự VẼ MỘT sơ đồ Mermaid đầy
  đủ từ chữ (`flows/<FLOW-ID>/as-is.mmd`), rồi vẫn đánh giá UX y như thường.

## Bước 1 — hiểu luồng (không ghi gì)

Với mỗi luồng: lập bảng cell → bước tài liệu (ví dụ `L_Timeout` ↔ "3.2 bước
4.2c"). Ghi nhận: điểm bắt đầu, các kết cục, các điểm rẽ nhánh và nhánh của
chúng, các bước hệ thống vs bước người dùng, và bước nào diễn ra trên màn nào
(để gắn `screens.json`).

Nếu sơ đồ và bảng mô tả **mâu thuẫn** (sơ đồ có nhánh bảng không có, hoặc
ngược lại) — đó là một phát hiện (`heuristic: "Nhất quán tài liệu"`), không
phải thứ để bạn tự "sửa" cho khớp.

## Bước 2 — đánh giá UX theo checklist (bắt buộc dùng đúng các mục này)

Chấm từng mục; mục nào có vấn đề thì thành một finding. Không chấm theo cảm
tính ngoài danh sách; mục nào không áp dụng thì bỏ qua, không bịa.

| # | Mục | Câu hỏi phải trả lời | `heuristic` ghi trong finding |
| --- | --- | --- | --- |
| 1 | Độ dài happy path | Số bước từ điểm vào tới mục tiêu có bước nào thừa/lặp/hỏi lại thứ đã biết không? | `Độ dài happy path` |
| 2 | Ngõ cụt | Nhánh lỗi / timeout / từ chối có đường quay lại hoặc kết cục rõ cho người dùng không? Có nhánh nào "kết thúc" mà người dùng không biết chuyện gì đã xảy ra? | `Nielsen#9 Recognize, diagnose, recover from errors` |
| 3 | Rẽ nhánh thiếu nhánh | Điểm quyết định nào chỉ có 1 lối ra, hoặc thiếu nhánh "Không/Thất bại"? | `Nielsen#5 Error prevention` |
| 4 | Phản hồi trạng thái | Bước hệ thống chạy lâu (thanh toán, gọi NCC, chờ giao hàng) có bước hiển thị trạng thái/thông báo cho người dùng không? | `Nielsen#1 Visibility of system status` |
| 5 | Mất dữ liệu khi quay lại | Quay lại giữa form nhiều bước có mất thứ đã nhập / có xác nhận không? Tài liệu có nói gì về Back không? | `Nielsen#3 User control and freedom` |
| 6 | Nhất quán tên gọi | Tên bước/màn/nút trong sơ đồ và trong bảng mô tả có khớp không? Cùng một màn gọi hai tên? | `Nhất quán tài liệu` / `Nielsen#4 Consistency and standards` |
| 7 | Gánh nặng nhận thức | Một bước bắt người dùng làm quá nhiều việc (nhập 6–7 trường không nhóm), quyết định khó không có gợi ý mặc định? | `Nielsen#6 Recognition rather than recall` |
| 8 | Ràng buộc nghiệp vụ | Đề xuất của bạn có phá BR nào không (KYC bắt buộc, thứ tự gạch nợ, ưu tiên NCC…)? Nếu có → **không đề xuất**, hoặc ghi rõ `conflictsWith`. | (ghi trong finding liên quan) |

**Mức độ** (`severity`): `blocker` — người dùng không hoàn thành được mục tiêu
hoặc mất tiền/không biết trạng thái; `major` — hoàn thành được nhưng gây nhầm
lẫn/quay lại rõ rệt; `minor` — tối ưu được; `note` — quan sát, không cần sửa.

**Mỗi finding BẮT BUỘC có `evidence`** — đường dẫn tài liệu + mục (ví dụ
`docs-feature/…/2.1-PRD.md#3.2 bước 4.2c`) hoặc chính cell của sơ đồ. Không có
căn cứ = không phải finding. Không suy diễn "thường thì phải có OTP/xác nhận".

## Bước 3 — ghi `flows/<FLOW-ID>/ux-review.json`

Một file cho mỗi luồng (kể cả luồng tốt — khi đó `findings: []`).

```json
{
  "flowId": "FLOW-mua-sim-du-lich",
  "verdict": "needs-improvement",
  "summary": "Happy path 7 bước hợp lý; nhánh timeout thanh toán và timeout NCC không cho người dùng biết tiền đang ở đâu.",
  "findings": [
    {
      "id": "UX-01",
      "severity": "major",
      "heuristic": "Nielsen#1 Visibility of system status",
      "title": "Timeout thanh toán kết thúc luồng mà không báo người dùng",
      "reason": "Sơ đồ đi thẳng từ 'Billing revert tiền' tới Kết thúc; bảng 3.2 bước 4.2c cũng chỉ nói Billing hoàn tiền, không có màn/thông báo nào cho KH.",
      "recommendation": "Thêm bước 'Hiện trạng thái đang xử lý + thông báo hoàn tiền' trước Kết thúc.",
      "evidence": ["docs-feature/sim/2.1-PRD.md#3.2 bước 4.2c", "cell L_Timeout"],
      "cells": { "asIs": ["L_Timeout"], "proposed": ["L_Timeout", "od-n1"] },
      "change": "added"
    }
  ]
}
```

- `verdict`: `good` | `needs-improvement` | `poor`.
- `findings[].id`: `UX-01`, `UX-02`, … duy nhất trong file.
- `cells.asIs`: id cell trong sơ đồ gốc mà finding nói tới; `cells.proposed`:
  id cell (cũ + mới) trong bản đề xuất. Viewer highlight theo các id này.
- `change`: `added` | `modified` | `removed` | `none` — loại sửa bạn đề xuất
  cho finding này (`none` khi chỉ nêu, không sửa).
- `conflictsWith` (tuỳ chọn): mã BR mà một đề xuất "tự nhiên" sẽ vi phạm, nếu
  bạn quyết định KHÔNG đề xuất vì lý do đó.

## Bước 4 — đề xuất trên sơ đồ gốc

### 4a. draw.io → `flows/<FLOW-ID>/patch.json`

Bạn **không viết XML**. Ghi danh sách thao tác; daemon áp lên trang gốc, tính
toạ độ cho node mới, tô màu theo chú giải cố định (xanh lá = thêm mới, vàng =
sửa đổi, đỏ gạch = đề nghị bỏ) và ghi `od-change`/`od-finding` lên cell.

```json
{
  "flowId": "FLOW-mua-sim-du-lich",
  "ops": [
    { "op": "relabel", "cell": "s1", "label": "Chọn Mua SIM → tab SIM Du lịch", "finding": "UX-03" },
    { "op": "mark", "cell": "confirm2", "change": "removed", "finding": "UX-02" },
    { "op": "addNode", "id": "od-n1", "shape": "action", "label": "Hiện trạng thái đang xử lý + thông báo hoàn tiền", "near": "L_Timeout", "dir": "below", "finding": "UX-01" },
    { "op": "addEdge", "id": "od-e1", "from": "L_Timeout", "to": "od-n1", "label": "", "finding": "UX-01" },
    { "op": "redirectEdge", "edge": "e12", "from": "od-n1", "finding": "UX-01" }
  ]
}
```

| `op` | Nghĩa | Trường |
| --- | --- | --- |
| `relabel` | Đổi nhãn một cell (node hoặc cạnh) — tô vàng | `cell`, `label`, `finding` |
| `mark` | Đánh dấu cell là `modified` (vàng) hoặc `removed` (đỏ gạch, cell VẪN CÒN để người xem thấy) | `cell`, `change`, `finding` |
| `addNode` | Thêm node mới cạnh `near` theo hướng `dir` (`below` mặc định / `right` / `left` / `above`) — tô xanh | `id` (bắt đầu bằng `od-`), `shape` (`action` / `decision` / `start` / `end`), `label`, `near`, `dir`, `finding` |
| `addEdge` | Thêm cạnh — tô xanh; `label` bắt buộc khi đi ra từ `decision` | `id` (bắt đầu bằng `od-`), `from`, `to`, `label`, `finding` |
| `redirectEdge` | Đổi đầu `from` và/hoặc `to` của cạnh có sẵn — tô vàng | `edge`, `from`?, `to`?, `finding` |

Luật:
- Mọi `cell`/`edge`/`near`/`from`/`to` phải là id có thật trong `cells.json`
  hoặc id `od-…` bạn vừa tạo trong CÙNG file (thao tác trước tạo, thao tác sau
  dùng). Id sai → daemon bỏ qua thao tác đó và ghi vào index — đừng để xảy ra.
- **Chỉ sửa cục bộ.** Không xoá cell (dùng `mark removed`), không di chuyển
  cell cũ, không vẽ lại luồng thay thế. Nếu luồng cần làm lại từ đầu → nói ở
  `summary` với `verdict: "poor"`, KHÔNG nặn ra hàng chục thao tác.
- Mỗi thao tác phải gắn `finding` — người xem bấm vào cell là ra lý do.
- Luồng tốt (`findings: []`) → **không tạo `patch.json`**.

### 4b. Mermaid → `flows/<FLOW-ID>/proposed.mmd`

Chép `as-is.mmd` sang `proposed.mmd` rồi sửa cục bộ bằng chính cú pháp
Mermaid, tô màu bằng ĐÚNG ba classDef này (daemon và viewer nhận diện theo
tên):

```
classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F
classDef od-modified fill:#FFF2CC,stroke:#D6B656,color:#5C4A00
classDef od-removed fill:#F8CECC,stroke:#B85450,stroke-dasharray:5 5,color:#5C1F1B
class OD_N1 od-added
class L_Timeout od-modified
```

- Node mới đặt id `OD_…`; node đề nghị bỏ GIỮ LẠI và gán `od-removed`.
- Cạnh mới nối bằng cú pháp thường; không xoá cạnh cũ — nếu muốn đổi hướng thì
  thêm cạnh mới và đánh dấu node liên quan `od-modified`.
- Cùng luật "chỉ sửa cục bộ", "luồng tốt thì không tạo file".
- Phần thêm vào phải giữ đúng "Quy tắc vẽ Mermaid dễ đọc" bên dưới (TD, nhãn
  ngắn, không tạo thêm vòng lặp ngược).

### Quy tắc vẽ Mermaid dễ đọc (áp cho `proposed.mmd` VÀ `as-is.mmd` text-only)

Chuẩn tham chiếu là sơ đồ "Luồng người dùng" (Mermaid) mà các PRD/URD của VNPAY hay
kèm: một flowchart **dọc**, đọc từ trên xuống, nhánh rẽ ra hai bên rồi **hội tụ
lại**, không có mạng nhện cạnh chéo. Cụ thể:

- `flowchart TD`, **MỘT** sơ đồ cho cả luồng (luồng chính + mọi nhánh thay thế
  + ngoại lệ). Không tách "kịch bản 1/2/3", không vẽ nhiều sơ đồ con.
- Hình: bắt đầu/kết thúc `A([Bắt đầu: …])` / `End([Kết thúc])`; hành động /
  màn hình `B[Chọn gói cước]`; quyết định `C{Kết quả thanh toán?}`. Nhãn dài
  xuống dòng bằng `<br>`, tối đa ~3 dòng; nhãn có ký tự đặc biệt (`(`, `:`,
  `/`) thì bọc trong dấu nháy kép `["…"]`.
- Quyết định là **câu hỏi cụ thể**, ≤ 8 từ, ra **2–3 nhánh**, nhãn nhánh ngắn
  (`-- "Thành công" -->`, `-- Timeout -->`, `-->|Có|`). KHÔNG dùng quyết định
  kiểu "KH làm gì?" toả 5–6 cạnh — tách thành các quyết định nối tiếp hoặc
  liệt kê các lối rẽ phụ thành nhánh riêng.
- Đường chính đi thẳng xuống; nhánh phụ rẽ ngang rồi quay về nút hội tụ (chọn
  gói → nhập thông tin → thanh toán → kết quả → kết thúc). Mọi nhánh cuối
  cùng gặp **một** `End` (hoặc tối đa 2 kết cục: thành công / dừng).
- **Hạn chế cạnh quay ngược** (loop): chỉ giữ tối đa 2 vòng lặp thật sự quan
  trọng (vd. "Thử lại" sau lỗi); các thao tác "quay lại màn trước", "đổi lựa
  chọn", "back" KHÔNG vẽ thành cạnh — ghi trong nhãn hoặc bỏ. Mỗi cạnh ngược là
  một đường cắt ngang sơ đồ.
- Kích thước: 15–45 node. Quá 45 → gộp các bước hệ thống liên tiếp thành một
  node ("SDK tạo đơn & điều hướng sang màn thanh toán"), không cắt sơ đồ.
- Bước diễn ra trên màn nào thì gọi TÊN màn (kèm mã trong ngoặc) trong nhãn:
  `H[Màn Nhập thông tin & thanh toán (4.4.1)]`. Bước hệ thống ghi chủ ngữ hệ
  thống (`Billing gạch nợ`, `SDK BE tạo đơn Pending`).
- Chia đoạn bằng chú thích `%% NHÁNH …` như ví dụ; không dùng `subgraph` (làm
  vỡ bố cục và không parse thành flowchart.json).

Mẫu rút gọn đúng chuẩn (từ sơ đồ "Luồng người dùng" trong PRD detail "Mua SIM du lịch" v1.0.1):

```
flowchart TD
    A([Bắt đầu: Mở App Kênh bán]) --> B[Chọn Mua SIM -> SIM Du lịch]
    B --> C_Type{Loại SIM du lịch?}
    %% NHÁNH 1: QUỐC TẾ
    C_Type -- "Quốc tế" --> C[Tìm kiếm & chọn Quốc gia / Khu vực]
    C --> D{Chọn loại SIM?}
    D -- eSIM --> E1[Danh sách gói cước eSIM]
    D -- SIM vật lý --> E2[Danh sách gói cước SIM vật lý]
    E1 --> G[Khách hàng chọn gói cước]
    E2 --> G
    %% NHÁNH 2: VIỆT NAM (chỉ eSIM)
    C_Type -- "Việt Nam" --> E3[Danh sách gói cước<br>eSIM Việt Nam]
    E3 --> G
    G --> H[Màn Nhập thông tin]
    H --> K[KH bấm Thanh toán]
    K --> L{Kết quả thanh toán?}
    L -- "Thất bại" --> L_Fail[Bank báo lỗi]
    L -- "Timeout" --> L_Timeout[Billing revert tiền cho KH]
    L -- "Thành công" --> SDK_Call[SDK gọi NCC xuất đơn]
    SDK_Call --> NCC{Kết quả xuất đơn?}
    NCC -- "Thành công" --> Deliver["NCC trả QR eSIM<br>-> gửi Email & hiện trong Lịch sử"]
    NCC -- "Thất bại" --> Revert[Billing revert tiền cho KH]
    %% HỘI TỤ
    L_Fail --> End([Kết thúc])
    L_Timeout --> End
    Deliver --> End
    Revert --> End
```

## Bước 5 — `flows/<FLOW-ID>/screens.json` (gắn màn hình cho bước)

Daemon tự sinh `flows/<FLOW-ID>.flowchart.json` từ sơ đồ nguồn (node, cạnh,
hình → `start`/`end`/`action`/`decision`). Thứ duy nhất nó cần bạn là **bước
nào diễn ra trên màn nào**, để `dr-comp` vẽ wireframe và viewer hiện
thumbnail:

```json
{
  "cells": {
    "s1": "2.1-PRD-Mua-SIM__SCR-001",
    "pay": "2.1-PRD-Mua-SIM__SCR-005"
  },
  "names": {
    "2.1-PRD-Mua-SIM__SCR-001": "Trang chủ SIM du lịch",
    "2.1-PRD-Mua-SIM__SCR-005": "Thông tin thanh toán"
  },
  "note": "Tài liệu không nói nhánh timeout NCC hiển thị gì cho KH."
}
```

- **SCREEN-KEY = `<file-stem>__<mã màn>`** — LUÔN prefix. `<file-stem>` = tên
  file `.md` chứa heading màn đó, bỏ đuôi `.md`, không đổi gì khác
  (`docs-feature/…/4.1.2.1.1.-URD-Mua-sim-thuong.md` →
  `4.1.2.1.1.-URD-Mua-sim-thuong`). `<mã màn>` = mã trong heading màn, nguyên
  văn (`SCR-001`, `SCR-002.1`, hoặc mã tài liệu dùng như `6.2.2`). Mã màn đánh
  lại từ đầu trong từng URD nên không prefix là đụng nhau; `dr-comp` đặt tên
  file wireframe đúng luật này, lệch một ký tự là màn mất thumbnail.
- Chỉ gắn cho bước NGƯỜI DÙNG diễn ra trên một màn tài liệu đã khai. Bước hệ
  thống ("Server kiểm tra", "Billing gạch nợ"), quyết định, kết cục thuần →
  không gắn. Không bịa mã màn.
- `names`: tên màn như tài liệu đặt (viewer hiện tên, không hiện key).
- `note` (tuỳ chọn): chỗ duy nhất ghi phần tài liệu mô tả mơ hồ về luồng này.

## Chế độ text-only (không tìm thấy sơ đồ nào)

Khi `flows/_inputs.json` báo không có sơ đồ: bạn **vẽ MỘT sơ đồ Mermaid đầy
đủ** từ chữ, rồi đánh giá UX và đề xuất y như luồng Mermaid có sẵn. Không ghi
`flowchart.json` (daemon tự suy từ `as-is.mmd`), không chia kịch bản.

- `FLOW-ID` = `FLOW-<việc>` không dấu, chỉ `[A-Za-z0-9-]`; mỗi luồng nghiệp vụ
  độc lập một thư mục — thường tài liệu chỉ có MỘT.
- Ghi `flows/<FLOW-ID>/as-is.mmd`: flowchart TD theo đúng "Quy tắc vẽ Mermaid
  dễ đọc" ở trên — luồng chính + mọi nhánh thay thế/ngoại lệ tài liệu mô tả,
  trong MỘT sơ đồ; node đầu là màn gốc người dùng đứng trước khi bắt đầu; mỗi
  bước suy được từ tài liệu (không bịa; không thêm bước "thường là vậy").
- Ghi `flows/<FLOW-ID>/ux-review.json` (Bước 3; `cells.asIs` = id node Mermaid).
- Có đề xuất → `flows/<FLOW-ID>/proposed.mmd` (Bước 4b) — sửa cục bộ trên chính
  `as-is.mmd` bạn vừa vẽ, tô 3 classDef; luồng tốt → không tạo.
- Ghi `flows/<FLOW-ID>/screens.json` với **thêm `title` và `source`** (vì không
  có `_inputs.json` để lấy): `title` = tên luồng như tài liệu gọi, `source` =
  đường dẫn `.md` chính (tương đối cwd); `cells` = id node Mermaid → SCREEN-KEY
  cho bước diễn ra trên màn; `names`, `note` như Bước 5.
- Tài liệu thuần định nghĩa dữ liệu, không mô tả thao tác nào → nói rõ là không
  tìm thấy luồng trong `ux-review.json` (summary) và không nặn ra sơ đồ ba node.

## Hard rules

- **Chỉ ghi vào `flows/<FLOW-ID>/`** (`ux-review.json`, `patch.json` hoặc
  `proposed.mmd`, `screens.json`; text-only thêm `as-is.mmd`). Không ghi
  `flowchart.json`, `docs/`, `docs-feature/`, `review/`. Không sửa `as-is.*`
  daemon đã tạo, `cells.json`, `_inputs.json`. Không tự tạo `proposed.drawio`
  hay `index.json` — daemon làm sau khi bạn xong.
- **Không bịa.** Mọi finding có `evidence`; mọi bước đề xuất phải suy được từ
  tài liệu hoặc từ chính lỗ hổng trong sơ đồ (nhánh thiếu, kết cục mù). Không
  thêm OTP/xác nhận/màn hình chỉ vì "thường là vậy".
- **Không phá BR.** Đề xuất trái quy tắc nghiệp vụ tài liệu ghi → bỏ hoặc gắn
  `conflictsWith`.
- **Sửa cục bộ, không vẽ lại.** Bản đề xuất phải nhìn giống bản gốc cộng vài chỗ
  tô màu; người đọc URD phải nhận ra sơ đồ của họ.
- File-only: không đẩy bất cứ gì lên KGS.
