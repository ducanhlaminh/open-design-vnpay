# IR Schema (v1)

Lớp trung gian JSON giữa **Extractor** và **Figma Plugin**. Đây là hợp đồng dữ liệu — cả hai mảnh chỉ nói chuyện qua đây.

## Node

```jsonc
{
  "type": "frame" | "text" | "image" | "vector",   // bắt buộc
  "name": "string",                       // tên layer trong Figma

  // chỉ cho type=vector (Phase 4.0 — inline <svg> icon)
  "svg": "<svg xmlns=...>...</svg>",      // markup đã bake currentColor + xmlns
  "_w": 24, "_h": 24,                     // px đo được; plugin rescale đồng đều

  // chỉ cho type=frame
  "layout": {
    "mode": "horizontal" | "vertical",
    "gap": 0,                             // px (itemSpacing)
    "padding": [top, right, bottom, left],// px
    "justify": "start|center|end|space-between",   // trục chính
    "align": "start|center|end|stretch",           // trục phụ
    "sizing": {
      "w": "fixed" | "fill" | "hug",
      "h": "fixed" | "fill" | "hug"
    },
    "width": 0,                           // chỉ khi w=fixed
    "height": 0                           // chỉ khi h=fixed
  },

  // style — dùng cho frame & image
  "style": {
    "fills":  [
      { "type": "solid", "color": { "r":0, "g":0, "b":0, "a":1 } },
      // Phase 3.1 — gradient (kind: "linear" | "radial" | "angular")
      { "type": "gradient", "kind": "linear",
        "stops": [ { "pos": 0, "color": { "r":0,"g":0,"b":0,"a":1 } },
                   { "pos": 1, "color": { "r":1,"g":1,"b":1,"a":1 } } ],
        // ma trận affine 2x3 của Figma: [[a,c,e],[b,d,f]] map object→paint
        "transform": [ [1,0,0], [0,1,0] ] }
    ],
    "radius": [tl, tr, br, bl],           // px mỗi góc
    "stroke": { "color": { "r":0,"g":0,"b":0,"a":1 }, "width": 1 },
    "effects": [
      // inset=true → INNER_SHADOW, ngược lại DROP_SHADOW
      { "type": "shadow", "inset": false, "x":0, "y":0, "blur":0, "spread":0,
        "color": { "r":0,"g":0,"b":0,"a":1 } },
      // Phase 3.3 — blur: backdrop-filter → BACKGROUND_BLUR; filter → LAYER_BLUR
      { "type": "background-blur", "radius": 20 },
      { "type": "layer-blur", "radius": 8 }
    ]
  },

  // chỉ cho type=text
  "text": {
    "content": "string",
    "size": 14,                           // px
    "weight": 400,                        // 100..900
    "color": { "r":0, "g":0, "b":0, "a":1 },
    "gradient": { /* Phase 3.3 — nếu có, fill text bằng gradient (background-clip:text) */ }
  },

  "component": "Button" | null,           // Phase 4: map DS instance

  // Phase 5 — nếu có, node là overlay tuyệt đối trong frame cha
  "absolute": {
    "x": 0, "y": 0,                       // px so với góc trái-trên cha
    "cx": "min|max|center|stretch",       // constraint ngang
    "cy": "min|max|center|stretch"        // constraint dọc
  },

  "children": [ /* Node đệ quy — chỉ frame mới có */ ]
}
```

## Quy ước màu
- `{r,g,b}` trong khoảng **0..1** (không phải 0..255). `a` = opacity 0..1.
- Màu trong suốt hoàn toàn (`a=0`) → extractor bỏ, không tạo fill.

## Quy ước fill (Phase 3.1)
- `fills` là mảng **xếp chồng**: phần tử **sau** nằm **trên** (giống thứ tự paint của Figma).
- `background-color` (solid) là lớp đáy; các `linear-gradient` xếp lên trên theo đúng thứ tự CSS.
- `gradient.stops[].pos` trong khoảng **0..1**.
- `gradient.transform` là `Transform` của Figma (`gradientTransform`): ma trận 2×3 `[[a,c,e],[b,d,f]]`, map toạ độ chuẩn hoá của object (0..1) sang không gian paint. Extractor tính sẵn từ góc CSS.

## Quy ước sizing (extractor suy luận)
| Tình huống CSS | IR sizing |
|---|---|
| Node gốc (root) | `w: fixed` (= width đo được), `h: hug` |
| `flex-grow > 0` trên trục chính của cha | trục chính = `fill` |
| Cha `align-items: stretch` | con tự stretch trục phụ (plugin xử lý qua `align:stretch`) |
| Còn lại | `hug` |

## Tối thiểu hợp lệ
```json
{ "type": "frame", "name": "X", "layout": { "mode": "vertical" }, "children": [] }
```
Các field thiếu → plugin dùng mặc định (gap 0, padding 0, fills rỗng…).
