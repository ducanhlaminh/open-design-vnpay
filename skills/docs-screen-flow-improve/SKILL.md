---
name: docs-screen-flow-improve
description: |
  Stage `dr-flow-improve` ("Cải thiện luồng") of the `docs-review` workflow —
  runs AFTER `dr-flow` ("Luồng màn hình", skill `docs-screen-flow`) and BEFORE
  `dr-comp`. REVIEWS the generated screen flow `flows/SCREEN-FLOW` against a
  fixed UX checklist and PROPOSES a better flow as SMALL LOCAL EDITS on that
  diagram: `patch.json` (relabel / mark / addNode / addEdge / redirectEdge —
  a new node that IS a screen carries `screen`) plus `ux-review.json`
  (findings with reason / evidence / cells). The daemon applies the patch into
  the colour-coded `proposed.drawio` (page "Nguyên bản" | "Cải thiện"), builds
  `screens.improved.json`, and the user picks which variant downstream stages
  use. Lean subset of `docs-flow-ux` with a FIXED input (the screen-flow
  folders only). Since 2026-08-28 a document with two platforms has TWO flows
  (`flows/SCREEN-FLOW--app/` + `flows/SCREEN-FLOW--web/`) — review each flow
  separately, `flowId` = the folder name.
  Activate when the user runs the "Cải thiện luồng" pipeline or asks to
  improve / UX-review a generated screen flow.
triggers:
  - "cải thiện luồng"
  - "đề xuất cải thiện luồng màn hình"
  - "ux review screen flow"
  - "cải thiện luồng màn hình"
  - "docs screen flow improve"
od:
  mode: utility
  category: ux-research
---

# docs-screen-flow-improve — review + đề xuất cải thiện LUỒNG MÀN HÌNH (`docs-review`)

Bạn là bước **Cải thiện luồng** của workflow `docs-review`. Bước Luồng màn hình
(`dr-flow`) đã vẽ `flows/<SCREEN-FLOW-ID>/as-is.drawio` từ tài liệu — với
`<SCREEN-FLOW-ID>` là `SCREEN-FLOW` (tài liệu một nền tảng) HOẶC cặp
`SCREEN-FLOW--app` + `SCREEN-FLOW--web` (tài liệu hai nền tảng; kickoff liệt
kê từng flow). **Review TỪNG flow RIÊNG**: mỗi flow có bộ input/output của
mình, không trộn cell/màn/finding giữa App và Web. Việc của bạn:
đọc luồng đó CÙNG tài liệu, chấm theo checklist UX bên dưới, và — khi có vấn
đề — đề xuất bản tốt hơn bằng vài thao tác SỬA NHỎ trên chính sơ đồ. Daemon tô
màu (xanh = thêm, vàng = sửa, đỏ gạch = bỏ) và người xem so "Nguyên bản" với
"Cải thiện" rồi tự chọn bản nào chạy tiếp (`selection.json` — KHÔNG phải việc
của bạn).

## Input (chỉ đọc, từ cwd của dự án) — cho MỖI flow `flows/<SCREEN-FLOW-ID>/`

- `flows/<SCREEN-FLOW-ID>/cells.json` — id ↔ nhãn của mọi node/cạnh (bản đồ để
  gọi tên cell trong `patch.json` / `ux-review.json`).
- `flows/<SCREEN-FLOW-ID>/as-is.drawio` — XML thuần, mở khi cần xem style/bố cục.
- `flows/<SCREEN-FLOW-ID>/screens.json` — danh sách màn (`screens[]` key/code/
  name/anchorText/cell/platform; `cells`/`names` dẫn xuất).
- Tài liệu: `docs-feature/**.md` (nguồn sự thật; `docs-app/` chỉ đối chiếu;
  dự án legacy dùng `docs/`). Bỏ qua `_index.md`, `attachments/`, `*.changes.json`,
  `*.notes.json`, `review/`, `*.slice.md`.

## Checklist UX (chấm đúng các mục này, không bịa mục khác)

| # | Mục | Câu hỏi | `heuristic` |
| --- | --- | --- | --- |
| 1 | Độ dài happy path | Bước thừa/lặp/hỏi lại thứ đã biết? | `Độ dài happy path` |
| 2 | Ngõ cụt | Nhánh lỗi/timeout có đường về hoặc kết cục rõ cho người dùng? | `Nielsen#9 Recognize, diagnose, recover from errors` |
| 3 | Rẽ nhánh thiếu nhánh | Quyết định chỉ 1 lối ra, thiếu "Không/Thất bại"? | `Nielsen#5 Error prevention` |
| 4 | Phản hồi trạng thái | Xử lý lâu (thanh toán, NCC) có màn/thông báo trạng thái? | `Nielsen#1 Visibility of system status` |
| 5 | Mất dữ liệu khi quay lại | Back giữa form nhiều bước có mất dữ liệu / có xác nhận? | `Nielsen#3 User control and freedom` |
| 6 | Nhất quán tên gọi | Tên màn/nút trong sơ đồ và tài liệu khớp nhau? | `Nhất quán tài liệu` / `Nielsen#4 Consistency and standards` |
| 7 | Gánh nặng nhận thức | Một màn bắt làm quá nhiều việc, quyết định khó không có mặc định? | `Nielsen#6 Recognition rather than recall` |
| 8 | Ràng buộc nghiệp vụ | Đề xuất có phá BR tài liệu ghi? Có → KHÔNG đề xuất hoặc ghi `conflictsWith`. | (ghi trong finding) |

`severity`: `blocker` (không hoàn thành được / mất tiền / mù trạng thái),
`major` (hoàn thành được nhưng nhầm lẫn rõ), `minor` (tối ưu được), `note`.
**Mỗi finding BẮT BUỘC có `evidence`** trích tài liệu (`docs-feature/…/x.md#6.4.2`)
hoặc chính cell sơ đồ. Không có căn cứ = không phải finding. Không suy diễn
"thường thì phải có OTP/xác nhận".

## Output 1 — `flows/<SCREEN-FLOW-ID>/ux-review.json` (luôn ghi, MỖI flow một file)

`flowId` = ĐÚNG tên thư mục (`SCREEN-FLOW`, `SCREEN-FLOW--app` hoặc
`SCREEN-FLOW--web`). Hai flow → hai file, id finding đánh riêng từng file.

```json
{
  "flowId": "SCREEN-FLOW--app",
  "verdict": "needs-improvement",
  "summary": "Happy path 5 màn hợp lý; thiếu màn xác nhận đơn trước thanh toán như 6.4.2 mô tả.",
  "findings": [
    {
      "id": "UX-01", "severity": "major", "heuristic": "Nielsen#5 Error prevention",
      "title": "Thiếu màn xác nhận đơn trước thanh toán",
      "reason": "Sơ đồ đi thẳng 6.4.1 → Thanh toán; tài liệu 6.4.2 nói KH xem lại đơn trước.",
      "recommendation": "Thêm màn Xác nhận đơn giữa 6.4.1 và Thanh toán.",
      "evidence": ["docs-feature/prd.md#6.4.2", "cell od-6-4-1"],
      "cells": { "asIs": ["od-6-4-1"], "proposed": ["od-6-4-1", "od-n1"] },
      "change": "added"
    }
  ]
}
```

`verdict`: `good` | `needs-improvement` | `poor`. `id` duy nhất `UX-01`, `UX-02`…
`cells.asIs` = id trong sơ đồ gốc; `cells.proposed` = id (cũ + mới) trong bản
cải thiện — viewer highlight theo đó. `change`: `added` | `modified` | `removed`
| `none`. Luồng tốt → `verdict: "good"`, `findings: []`.

## Output 2 — `flows/<SCREEN-FLOW-ID>/patch.json` (chỉ khi có đề xuất, MỖI flow một file)

Bạn **không viết XML**. Ghi danh sách thao tác; daemon áp lên sơ đồ, tính toạ
độ, tô màu, gắn `od-change`/`od-finding` lên cell. `flowId` = tên thư mục;
mọi `cell`/`near`/`from`/`to` phải là id trong `cells.json` CỦA CHÍNH flow đó.

```json
{
  "flowId": "SCREEN-FLOW--app",
  "ops": [
    { "op": "addNode", "id": "od-n1", "shape": "action", "label": "6.4.2 · Xác nhận đơn", "near": "od-6-4-1", "dir": "below", "finding": "UX-01",
      "screen": { "key": "prd__6.4.2", "name": "Xác nhận đơn", "anchorText": "#### 6.4.2 Xác nhận đơn" } },
    { "op": "addEdge", "id": "od-ne1", "from": "od-6-4-1", "to": "od-n1", "label": "Tiếp tục", "finding": "UX-01" },
    { "op": "redirectEdge", "edge": "od-e4", "from": "od-n1", "finding": "UX-01" },
    { "op": "relabel", "cell": "od-e2", "label": "Mua SIM du lịch", "finding": "UX-02" },
    { "op": "mark", "cell": "od-6-3-9", "change": "removed", "finding": "UX-03" }
  ]
}
```

| `op` | Nghĩa | Trường |
| --- | --- | --- |
| `relabel` | Đổi nhãn node/cạnh — vàng | `cell`, `label`, `finding` |
| `mark` | Đánh dấu `modified` (vàng) hoặc `removed` (đỏ gạch, cell VẪN CÒN) | `cell`, `change`, `finding` |
| `addNode` | Node mới cạnh `near` theo `dir` (`below` mặc định / `right` / `left` / `above`) — xanh | `id` (`od-…`), `shape` (`action`/`decision`/`start`/`end`), `label`, `near`, `dir`, `finding`, `screen?` |
| `addEdge` | Cạnh mới — xanh; `label` bắt buộc khi đi ra từ `decision` | `id` (`od-…`), `from`, `to`, `label`, `finding` |
| `redirectEdge` | Đổi đầu `from`/`to` của cạnh có sẵn — vàng | `edge`, `from`?, `to`?, `finding` |

**`addNode.screen`** — node mới LÀ một màn người dùng nhìn thấy thì BẮT BUỘC
có `screen: { key, name, anchorText? }`; node hệ thống / kết cục thì KHÔNG.
`key` = `<file-stem>__<mã màn>` (stem = tên file `.md` bỏ đuôi; mã như trong
heading). Tài liệu chưa có mã cho màn này → `key` = `<file-stem>__NEW-<slug>`
(slug không dấu, `[a-z0-9-]`) và KHÔNG có `anchorText`. Trong flow tách theo
nền tảng, thêm hậu tố `--app`/`--web` khớp flow vào cuối key
(`<file-stem>__NEW-<slug>--app`). `anchorText` chỉ khi
tài liệu thật sự có MỘT dòng nguyên văn duy nhất khai màn đó. Daemon đưa màn
này vào `screens.improved.json` (`provenance: "proposed"`) cho dr-comp.

Luật:
- Mọi `cell`/`edge`/`near`/`from`/`to` là id có thật trong `cells.json` hoặc
  id `od-…` bạn vừa tạo TRƯỚC ĐÓ trong cùng file. Id sai → daemon bỏ thao tác.
- **Không đụng cell `od-legend-*`** (khối chú thích) — không relabel/mark/nối.
- **Chỉ sửa cục bộ.** Không xoá cell (dùng `mark removed`), không di chuyển
  cell cũ, không vẽ lại. Cần làm lại từ đầu → `verdict: "poor"` + `summary`,
  không nặn hàng chục thao tác.
- Mỗi thao tác gắn `finding` có thật trong `ux-review.json`.
- Nhánh mới THAY THẾ đường cũ → `redirectEdge` cạnh cũ (không để hai đường
  song song từ cùng một node).
- Luồng tốt (`findings: []`) → **KHÔNG tạo `patch.json`**.

## Hard rules

- Chỉ ghi ĐÚNG 2 file trên **cho mỗi flow** (2 flow → 4 file). **Cấm ghi**: `screen-flow.cells.xml`, `as-is.*`,
  `cells.json`, `screens.json`, `proposed.*`, `screens.improved.json`,
  `selection.json`, `_inputs.json`, `index.json`, `*.flowchart.json`, `docs*/`,
  `comp/`, `review/`.
- Không bịa: mọi finding có `evidence`; mọi bước đề xuất suy được từ tài liệu
  hoặc từ lỗ hổng của chính sơ đồ (nhánh thiếu, kết cục mù). Không phá BR.
- File-only: không đẩy gì lên KGS, không hỏi lại — job không có người ngồi cạnh.
