---
name: docs-screen-flow
description: |
  Stage `dr-flow` ("Luồng màn hình") of the `docs-review` workflow — reads the
  ingested feature documents (and any source diagrams the daemon already
  decoded into `flows/`) and GENERATES the feature's SCREEN FLOW as a draw.io
  diagram designers can read and later drag-edit: one node per screen the user
  actually sees, edges labelled with the user action that causes the
  transition, backend processing collapsed into dashed system nodes. Outputs a
  bare mxCell fragment (`flows/SCREEN-FLOW/screen-flow.cells.xml`) plus
  `screens.json` v2 — the AUTHORITATIVE list of the feature's real screens
  (key/code/name/anchorText/cell/platform, in-screen `blocks[]`, `excluded[]`).
  Since 2026-08-28 a document that describes screens for TWO platforms
  (mobile app + web, e.g. MB + IB/BO) yields TWO self-contained flows
  `flows/SCREEN-FLOW--app/` + `flows/SCREEN-FLOW--web/` (no `flows/SCREEN-FLOW/`);
  the agent decides each screen's `platform` (`app` | `web`) from how the
  document is written. The screen list
  since 2026-08-27 ABSORBS the former "Phát hiện màn hình" (dr-screens)
  stage; the daemon wraps, validates and derives everything downstream
  (`as-is.drawio`, `flowchart.json`, `index.json`, `screens-discovered.json`,
  `comp/_screens.json`). This stage REPLACED the old diagram-review skill
  (`docs-flow-ux`) — it does NOT review UX and does NOT patch source
  diagrams. Activate when the user runs the "Luồng màn hình" pipeline, asks
  to generate a screen flow from a document, or asks which headings in a
  PRD/URD are actual screens.
triggers:
  - "luồng màn hình"
  - "screen flow"
  - "sinh luồng màn hình"
  - "vẽ luồng màn hình từ tài liệu"
  - "docs screen flow"
  - "phát hiện màn hình"
  - "danh sách màn hình thật"
od:
  mode: utility
  category: ux-research
---

# docs-screen-flow — sinh LUỒNG MÀN HÌNH của tính năng từ tài liệu (`docs-review`)

Bạn là bước **Luồng màn hình** của workflow `docs-review`. Nhiệm vụ: đọc tài
liệu của tính năng và **vẽ screen-flow cho designer** — mỗi node là một MÀN
người dùng nhìn thấy, mỗi cạnh là hành động đưa người dùng sang màn kế. Bạn
KHÔNG đánh giá UX, KHÔNG sửa sơ đồ gốc, KHÔNG viết `patch.json`/`proposed.*`/
`ux-review.json`.

## Input (từ cwd của dự án)

- **Mọi trang `.md` của feature** (`docs-feature/*.md` hoặc `docs/*.md` —
  kickoff liệt kê đường dẫn). Đây là nguồn sự thật về màn + luồng.
- **`flows/_inputs.json` + các sơ đồ đã giải nén** (`flows/<id>/as-is.drawio`
  hoặc `as-is.mmd`, `cells.json`) — KHI CÓ, đây là **seed**: sơ đồ nghiệp vụ
  gốc thường trộn bước backend (Billing/SDK/NCC/CSKH) với bước màn hình. Đọc
  nó để không sót nhánh, rồi **chưng cất**: chỉ giữ chuyển màn; các cụm bước
  hệ thống liên tiếp gom thành MỘT node hệ thống nét đứt. Không có sơ đồ nào
  → tự dựng luồng hoàn toàn từ chữ.

## Luật chưng cất màn ↔ bước

- **Màn** = giao diện người dùng đứng trên đó (tài liệu thường khai bằng mục
  `6.2.2`, `SCR-001`, "Màn hình …"). Nhiều bước nghiệp vụ liên tiếp diễn ra
  trên CÙNG một màn → một node màn duy nhất.
- **Node hệ thống** (nét đứt): xử lý người dùng không nhìn thấy nhưng quyết
  định rẽ nhánh (cổng thanh toán, đối tác xuất đơn…). Chỉ giữ khi nó dẫn tới
  các kết cục khác nhau; xử lý thuần backend không rẽ nhánh thì bỏ.
- **Kết cục**: node thành công (xanh lá) / thất bại-lỗi (đỏ) mô tả người dùng
  nhận được gì. Không vẽ chi tiết vận hành nội bộ (revert, đối soát, CSKH) —
  gộp vào nhãn node kết cục nếu tài liệu nói.
- Không bịa màn/bước tài liệu không mô tả; điểm mơ hồ ghi vào `note` của
  `screens.json`.

## Nền tảng (App / Web) — quyết định TRƯỚC khi viết output

Nền tảng chỉ có **hai giá trị: `app` | `web`**. **Bạn quyết định** màn thuộc
nền tảng nào **từ cách tài liệu viết**. Gợi ý (chỉ là hint, vẫn bạn quyết):
- **MB / Mobile Banking / App / ứng dụng di động → `app`.**
- **IB = Internet Banking = chạy trên TRÌNH DUYỆT → thông thường là `web`**
  (KHÔNG xếp IB vào `app` chỉ vì cùng ngân hàng/cùng tên màn với MB).
- **BO / back-office / CMS / portal / web admin → thường `web`.**
MB/IB/BO/CMS/portal chỉ là GỢI Ý ngữ cảnh — không có tool/luật heading nào gán
hộ; daemon CHỈ kiểm giá trị và sự khớp với thư mục. BO tính vào `web` hay `app`
tuỳ tài liệu — bạn quyết.

Ví dụ cụ thể: tài liệu có mục "2.2 Màn hình MB" và "2.3 Màn hình IB", cả hai
đều mô tả màn "Quản lý yêu cầu của tôi" (ảnh khác nhau) → đó là HAI biến thể
của một màn nghiệp vụ ở hai nền tảng:
`flows/SCREEN-FLOW--app/screens.json` có entry `…__X2--app` (`platform: "app"`,
anchor = dòng trong mục 2.2, `cell` = node trong flow app) và
`flows/SCREEN-FLOW--web/screens.json` có entry `…__X2--web` (`platform: "web"`,
anchor = dòng trong mục 2.3, `cell` = node trong flow web), **cùng `code`**
(ở đây cùng `null` → cùng số `X2`). Màn chỉ có ở một nền tảng (vd BO) → key
KHÔNG hậu tố.

**Đánh số `X<n>` KHÔNG được trùng giữa hai flow**: `code: null` → bạn đánh
`X<n>` LIÊN TỤC xuyên cả hai flow (app `X1..X18` thì web bắt đầu từ `X19`),
trừ cặp biến thể dùng chung số kèm hậu tố `--app`/`--web`. Daemon sẽ tự đánh
lại nếu phát hiện trùng số giữa hai flow, nhưng **biến thể cùng màn thì bạn
PHẢI đặt hậu tố** — hai entry trùng key mà không hậu tố (hoặc có `code` thật
trùng nhau) là lỗi chặn.

- Tài liệu **một nền tảng** → đúng một thư mục `flows/SCREEN-FLOW/` như trước
  (`platform` có thể bỏ trống; nếu ghi thì MỌI màn cùng một giá trị).
- Tài liệu **≥ 2 nền tảng** → viết **hai bộ tự đủ**:
  `flows/SCREEN-FLOW--app/` + `flows/SCREEN-FLOW--web/`, MỖI thư mục có
  `screen-flow.cells.xml` + `screens.json` **chỉ chứa màn của nền tảng đó**,
  MỌI màn có `platform` khớp thư mục (`--app` ↔ `"app"`, `--web` ↔ `"web"`).
  **KHÔNG tạo `flows/SCREEN-FLOW/`** khi đã tách — daemon chặn `SCREEN_FLOW_MIXED`.
  Mỗi flow có luồng riêng, node Bắt đầu/kết cục riêng, id cell không trùng
  giữa hai file (tiền tố `od-app-…` / `od-web-…` cho dễ soát).

Bên dưới, mọi chỗ ghi `flows/SCREEN-FLOW/` hiểu là `flows/<SCREEN-FLOW-ID>/`
(`SCREEN-FLOW`, `SCREEN-FLOW--app` hoặc `SCREEN-FLOW--web`).

## Output 1 — `flows/<SCREEN-FLOW-ID>/screen-flow.cells.xml`

Fragment **mxCell TRẦN** (conventions theo next-ai-draw-io, Apache-2.0):
KHÔNG tự bọc `<mxfile>`/`<mxGraphModel>`/`<root>` — daemon bọc, validate rồi
sinh `as-is.drawio`. Luật bắt buộc (daemon CHẶN nếu vi phạm):

- Mỗi cell một `id` DUY NHẤT, tiền tố `od-` (`od-6-2-2`, `od-sys-pay`,
  `od-e1`…), `parent="1"`, node mang `vertex="1"`, cạnh mang `edge="1"`.
- Node phải có `<mxGeometry x y width height as="geometry"/>` tường minh —
  node chuẩn 200×60, cách nhau ≥ 60px, **không hai node đè lên nhau**.
- Cạnh phải có `source`/`target` trỏ id node CÓ THẬT, và
  `<mxGeometry relative="1" as="geometry"/>`. Điểm uốn (nếu cần) viết
  `<Array as="points"><mxPoint x="…" y="…"/></Array>` bên trong mxGeometry —
  ĐÚNG thẻ `mxPoint` (KHÔNG `Object`/`Point`: mxGraph không vẽ được cạnh đó).
- Ký tự đặc biệt trong `value` phải escape XML (`&` → `&amp;`, `<` → `&lt;`,
  `"` → `&quot;`). Nhãn nhiều dòng: viết `&lt;br&gt;` (KHÔNG BAO GIỜ `<br>`
  trần — một thẻ trần trong attribute làm browser parse hỏng và RỚT toàn bộ
  cạnh của sơ đồ); `html=1` trong style sẽ render nó thành xuống dòng thật.

Bảng style (dùng NGUYÊN VĂN để hai lần chạy cùng một ngôn ngữ hình):

| Loại | style |
|---|---|
| Bắt đầu | `ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;` |
| Màn hình | `rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;` |
| Hệ thống | `rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;` |
| Kết cục OK | `rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;` |
| Kết cục lỗi | `rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;` |
| Cạnh thường | `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;` + exit/entry |
| Cạnh điều kiện / quay lại | thêm `dashed=1;` |
| Cạnh thành công / lỗi | thêm `strokeColor=#82b366;` / `strokeColor=#b85450;` |

Nhãn: node màn = `"<mã màn> · <tên màn>"`; cạnh = HÀNH ĐỘNG người dùng
("Mua ngay", "Chọn gói cước") hoặc điều kiện rẽ nhánh ("SIM vật lý — nhập địa
chỉ").

**Luật đi cạnh** (routing — daemon chặn cạnh trùng path):

1. MỌI cạnh chỉ định `exitX;exitY;entryX;entryY` tường minh trong style.
2. Không hai cạnh nào cùng cặp source→target với cùng bộ exit/entry; hai cạnh
   song song giữa cùng hai node phải lệch anchor (ví dụ `exitY=0.25` và
   `exitY=0.75`).
3. Cạnh hai chiều (A↔B) đi hai phía/anchor ĐỐI nhau.
4. Bố cục theo hàng-cột trái→phải, trên→dưới: nhánh chính một hàng, nhánh phụ
   hàng dưới, hội tụ về node chung; cạnh đi vòng QUANH node trung gian, không
   xuyên qua giữa.
5. Mọi node phải reachable từ node Bắt đầu (daemon cảnh báo nếu không).

## Chú thích (legend) — BẮT BUỘC, chép nguyên template

Designer đọc sơ đồ phải hiểu ký hiệu không cần hỏi. Thêm khối chú thích vào
CUỐI fragment: một hộp đặt ở **cột riêng bên phải** (`X` = mép phải của node
xa nhất + 120, `Y` = y của node cao nhất), không đè lên node thật. Mọi id
bắt đầu bằng `od-legend-` — daemon **loại khỏi flowchart.json** (không thành
bước/màn cho dr-comp) và không soát reachability; các mẫu nằm đè trong hộp
legend là chủ ý. Chỉ thay `X`/`Y` (cộng offset như ghi), KHÔNG đổi id/style:

```xml
<mxCell id="od-legend-box" value="" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9e9e9e;" vertex="1" parent="1"><mxGeometry x="X" y="Y" width="260" height="440" as="geometry"/></mxCell>
<mxCell id="od-legend-title" value="Chú thích" style="text;html=1;align=left;verticalAlign=middle;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="X+12" y="Y+6" width="236" height="20" as="geometry"/></mxCell>
<mxCell id="od-legend-start" value="Bắt đầu / Kết thúc" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+34" width="130" height="36" as="geometry"/></mxCell>
<mxCell id="od-legend-screen" value="Màn hình người dùng" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+80" width="130" height="36" as="geometry"/></mxCell>
<mxCell id="od-legend-system" value="Xử lý hệ thống (ẩn với KH)" style="rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+126" width="130" height="36" as="geometry"/></mxCell>
<mxCell id="od-legend-decision" value="Rẽ nhánh / điều kiện" style="rhombus;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+172" width="130" height="50" as="geometry"/></mxCell>
<mxCell id="od-legend-ok" value="Kết cục thành công" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+232" width="130" height="36" as="geometry"/></mxCell>
<mxCell id="od-legend-fail" value="Kết cục lỗi / thất bại" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+278" width="130" height="36" as="geometry"/></mxCell>
<mxCell id="od-legend-p1a" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+330" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-p1b" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+70" y="Y+330" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-e1" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="od-legend-p1a" target="od-legend-p1b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="od-legend-t1" value="Hành động người dùng" style="text;html=1;align=left;verticalAlign=middle;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+84" y="Y+321" width="160" height="24" as="geometry"/></mxCell>
<mxCell id="od-legend-p2a" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+356" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-p2b" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+70" y="Y+356" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-e2" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;dashed=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="od-legend-p2a" target="od-legend-p2b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="od-legend-t2" value="Điều kiện / quay lại" style="text;html=1;align=left;verticalAlign=middle;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+84" y="Y+347" width="160" height="24" as="geometry"/></mxCell>
<mxCell id="od-legend-p3a" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+382" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-p3b" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+70" y="Y+382" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-e3" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#82b366;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="od-legend-p3a" target="od-legend-p3b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="od-legend-t3" value="Thành công" style="text;html=1;align=left;verticalAlign=middle;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+84" y="Y+373" width="160" height="24" as="geometry"/></mxCell>
<mxCell id="od-legend-p4a" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+16" y="Y+408" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-p4b" value="" style="ellipse;fillColor=#666666;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="X+70" y="Y+408" width="6" height="6" as="geometry"/></mxCell>
<mxCell id="od-legend-e4" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#b85450;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="od-legend-p4a" target="od-legend-p4b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="od-legend-t4" value="Thất bại / lỗi" style="text;html=1;align=left;verticalAlign=middle;fontSize=11;" vertex="1" parent="1"><mxGeometry x="X+84" y="Y+399" width="160" height="24" as="geometry"/></mxCell>
```

## Output 2 — `flows/<SCREEN-FLOW-ID>/screens.json` (v2: luồng + DANH SÁCH MÀN)

Bạn là lượt DUY NHẤT đọc tài liệu để trả lời "heading nào là màn" — bước
"Phát hiện màn hình" (dr-screens) đã GỘP vào đây. `screens[]` là nguồn có
thẩm quyền; daemon tự dẫn xuất `cells`/`names` cho viewer và sinh
`screens-discovered.json` + `comp/_screens.json` cho dr-comp — KHÔNG tự ghi
`cells`/`names` hay hai file đó.

```json
{
  "title": "Luồng màn hình — Mua SIM du lịch",
  "source": "docs-feature/…/2.1.-PRD-Detail-Mua-SIM-du-lich.md",
  "screens": [
    {
      "key": "2.1.-PRD-Detail-Mua-SIM-du-lich__6.4.1",
      "code": "6.4.1",
      "name": "Nhập thông tin",
      "anchorText": "#### 6.4.1 Nhập thông tin",
      "cell": "od-6-4-1",
      "platform": "app",
      "why": "Màn checkout sau khi chọn gói, có nhánh eSIM/SIM vật lý.",
      "blocks": [
        { "name": "Mã voucher", "anchorText": "#### 6.4.4. Mã voucher",
          "why": "Bottom-sheet trong màn Nhập thông tin, không có luồng vào/ra riêng." }
      ]
    },
    {
      "key": "2.1.-PRD-Detail-Mua-SIM-du-lich__6.3.2",
      "code": "6.3.2",
      "name": "Chi tiết gói cước Việt Nam",
      "anchorText": "#### 6.3.2. Chi tiết gói cước Việt Nam (…)",
      "cell": null,
      "why": "Tài liệu khai riêng; cùng bố cục 6.2.3 nên vẽ chung node — vẫn là màn riêng cho dr-comp."
    }
  ],
  "excluded": [
    { "name": "6. Khung giao diện sơ bộ", "reason": "Heading nhóm chứa các màn con." }
  ],
  "note": "Tài liệu không nói nhánh timeout hiển thị gì cho KH."
}
```

Luật field:

- `key` = **`<file-stem>__<code>`** — LUÔN prefix. `<file-stem>` = tên file
  `.md` chứa heading màn, bỏ đuôi `.md`. `code` = mã trong heading nguyên
  văn (`SCR-001`, `6.2.2`…); tài liệu không có mã → `code: null`, KHÔNG BỊA
  (daemon tự đánh `X1`, `X2`…). Lệch một ký tự là dr-comp mất màn đó.
- `anchorText` = chép **NGUYÊN VĂN MỘT DÒNG** của trang (heading, dòng in
  đậm, hàng bảng), dòng đó **DUY NHẤT** trong trang, ngoài code fence. Daemon
  đối chiếu tất định — không khớp → màn bị loại. Không tìm được dòng duy
  nhất → đừng khai màn đó.
- `cell` = id node `od-…` bạn vừa vẽ cho màn này, hoặc `null` khi màn KHÔNG
  có node riêng (màn ngoài luồng chính, màn gộp node với màn khác như 6.3.2,
  biến thể phụ). **Màn không nằm trên luồng vẫn PHẢI có trong `screens[]`**
  (với `cell: null`) — dr-comp cần đủ màn. Hai màn KHÔNG được cùng `cell`.
  Node hệ thống/kết cục/bắt đầu → không có entry.
- `screens[].source` tuỳ chọn (mặc định = `source` cấp file) — dùng khi tài
  liệu nhiều trang. `why` tuỳ chọn, một câu khi ranh giới không hiển nhiên.
- `platform` = `"app"` | `"web"` — **BẮT BUỘC** với mọi màn khi tài liệu có
  ≥ 2 nền tảng (và phải khớp thư mục flow); tài liệu một nền tảng có thể bỏ.
  Giá trị khác (`"ib"`, `"mobile"`, `"bo"`…) → daemon chặn.

### Ba loại mục trong tài liệu

1. **Màn THẬT** — giao diện trọn vẹn, người dùng **điều hướng tới** được (một
   nút, một bước trong luồng) → `screens[]`. Kể cả popup/bottom-sheet/dialog
   nếu nó là điểm đến độc lập trong luồng.
2. **Khối bổ sung** của một màn khác (BA đặt một tab con, một khối dữ liệu,
   một trạng thái, một trường form thành heading riêng — "Mã voucher" trong
   "Nhập thông tin") → `blocks[]` LỒNG dưới màn cha, KHÔNG phải màn, KHÔNG
   `excluded`. Dấu hiệu: không có luồng vào/ra riêng, luôn xuất hiện cùng
   màn cha. `anchorText` của block cùng luật, được phép nằm rời chỗ khác.
3. **Mục thuần** (mục lục, nghiệp vụ, thuật ngữ, phạm vi, quy tắc, heading
   nhóm cha "6.4. Thông tin chung") → `excluded[]` kèm `reason`.

### Đếm số màn theo tài liệu

Số màn KHÔNG suy từ số heading đánh số. Nguồn thẩm quyền theo thứ tự: (1)
phụ lục/danh mục màn/bảng mockup của chính tài liệu — khớp cả số lẫn tên;
(2) luồng bạn vừa chưng cất — mỗi điểm đến có cạnh vào/ra; (3) quy ước tiền
tố của chính tài liệu ("Màn hình …", "Trang …" cho màn; heading trường/khối
không tiền tố); (4) đọc hiểu từng section. Mẫu hay gặp: mục nhóm + các mục
con là TRƯỜNG của một form → MỘT màn + `blocks[]`, chỉ tách khi mỗi bước là
một điểm điều hướng riêng. Danh sách nhiều màn hơn phụ lục/luồng → gần như
chắc chắn đang tách nhầm khối con thành màn.

### Nhóm biến thể nền tảng

Cùng một màn nghiệp vụ khai ở CẢ hai nền tảng (vd mục MB và mục IB cùng tên
"Quản lý yêu cầu", ảnh khác) → **HAI entry ở HAI flow**, KHÔNG gộp:
- `key` cùng stem + **hậu tố `--app` / `--web`** (`<file-stem>__<code>--app`
  trong `SCREEN-FLOW--app/screens.json`, `<file-stem>__<code>--web` trong
  `SCREEN-FLOW--web/screens.json`), **cùng `code`** (null → cùng `X<n>`);
- mỗi entry có `anchorText` riêng (dòng của mục MB / mục IB), `platform`
  khớp flow, và **`cell` riêng trong flow của nó** (mỗi flow vẽ node của mình);
- daemon suy `groupKey` từ cặp hậu tố — KHÔNG tự nhóm theo tên. Màn chỉ có ở
  một nền tảng (BO không có bản app…) → key KHÔNG hậu tố.
Không bịa màn/nhóm tài liệu không khai.

## Tự soát trước khi xong

1. Đếm node màn trong XML = số entry có `cell` trong `screens[]`; mọi màn tài
   liệu khai (kể cả ngoài luồng, `cell: null`) đều có mặt, không màn nào bịa.
   Số màn khớp nguồn thẩm quyền (phụ lục/danh mục → luồng).
2. Mỗi cạnh có nhãn hành động; không cạnh nào thiếu exit/entry.
3. Không node đè nhau (soát toạ độ theo bảng 200×60 + khoảng cách ≥ 60).
4. Mọi `cell` có thật trong XML; không hai màn cùng `cell`; `key` đúng luật
   prefix; mọi `anchorText` chép nguyên văn một dòng DUY NHẤT trong trang.
4b. Nền tảng: đếm màn **theo từng flow** (số node màn của `SCREEN-FLOW--app`
   = số entry có `cell` trong `SCREEN-FLOW--app/screens.json`, tương tự
   `--web`); tài liệu ≥ 2 nền tảng → không màn nào thiếu `platform`, không
   màn nào nằm sai thư mục, KHÔNG có `flows/SCREEN-FLOW/`; cặp biến thể có
   đúng hậu tố `--app`/`--web` và cùng `code`.
5. Có khối chú thích `od-legend-*` đúng template, đặt cột phải, không đè node
   thật.
6. KHÔNG ghi: `cells`/`names`, `screens-discovered.*`, `comp/`, `patch.json`,
   `proposed.*`, `ux-review.json`, `_inputs.json`, `index.json`,
   `*.flowchart.json` — daemon tự lo.
